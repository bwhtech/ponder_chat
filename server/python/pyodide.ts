import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as PonderConfig from "../config.ts";
import * as Tracing from "../tracing/Tracing.ts";
import { RUN_TIMEOUT_MS } from "./schema.ts";

/**
 * Runs Python in Pyodide inside a Deno process with no permissions (sandbox/pyodide/runner.ts),
 * one process per run, as LangChain's pyodide-sandbox does. This file starts the process,
 * passes the request on stdin, and ends the process when the run is over its time or
 * memory limit, or when the run is interrupted. Runs take turns: at most PYTHON_MAX_RUNS
 * at once on the server.
 *
 * Deno's permissions are the wall: the process may only read Pyodide and the vendored
 * packages. It gets no environment from the server (no keys), no network, no writes
 * and no subprocesses. setup.sh must have run once (`npm run sandbox:setup`).
 */
const RUN_TIMEOUT = Duration.millis(RUN_TIMEOUT_MS);
/** How often the process's memory is read. */
const MEMORY_CHECK = Duration.millis(250);
/** What is kept of stderr, for the error of a run that failed. */
const MAX_STDERR = 20_000;

export const SandboxFile = Schema.Struct({ path: Schema.String, base64: Schema.String });
export type SandboxFile = typeof SandboxFile.Type;
/** What a chat's runs keep between them (state.ts): the variables as a dill snapshot, their modules, the files in /work. */
export const SavedState = Schema.Struct({ globals: Schema.optional(Schema.String), imports: Schema.Array(Schema.String), files: Schema.Array(SandboxFile) });
export type PythonState = typeof SavedState.Type;

/** The runner's reply line (runner.ts's Reply). */
const RunnerReply = Schema.Struct({
	ok: Schema.Boolean,
	stdout: Schema.String,
	stderr: Schema.String,
	error: Schema.optional(Schema.String),
	outputs: Schema.Array(SandboxFile),
	skippedOutputs: Schema.Array(Schema.String),
	state: Schema.optional(SavedState),
	stateNote: Schema.optional(Schema.String),
	packages: Schema.Array(Schema.String),
});
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(RunnerReply));

export type RunRequest = { code: string; files?: ReadonlyArray<SandboxFile>; state?: PythonState };
export type RunReply = typeof RunnerReply.Type & {
	/** Set when the server stopped the run: "time" or "memory". */
	stopped?: "time" | "memory";
};

export class Sandbox extends Context.Service<
	Sandbox,
	{
		/** PONDER_PYTHON is not "off". The sandbox may still be missing: `check` says. */
		readonly enabled: boolean;
		/** Checks at start-up that Deno and the cached packages are there. Turns Python off with a log line if not. */
		readonly check: Effect.Effect<boolean>;
		/** Whether Python is on: the start-up check's answer, once it has one. /api/features and the replies wait for it. */
		readonly ready: Effect.Effect<boolean>;
		/** The check's answer, or none while it runs: the chat page's first screen does not wait (boot-page.ts). */
		readonly readyNow: Effect.Effect<Option.Option<boolean>>;
		/** Python is off for this start, because start-up failed before the check (startup.ts): nothing waits for it forever. */
		readonly turnOff: Effect.Effect<void>;
		/**
		 * Runs the code in a new process, in its turn. A run that fails, or that the server
		 * stops, is a reply with `ok: false`, not a failure. Interrupting the run ends its process.
		 */
		readonly run: (request: RunRequest) => Effect.Effect<RunReply>;
	}
>()("ponder/python/Sandbox") {}

const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	// From the project folder, not this file: the server runs bundled from .output/.
	const dir = `${resolve(config.sandboxDir)}/`;
	const deno = config.deno;
	const memoryMb = config.pythonMemoryMb;
	// A run that ends hands its slot to the next one waiting, so a new caller can't take it
	// first. A PYTHON_MAX_RUNS that is not a number never held a run back before.
	const slots = yield* Semaphore.make(Number.isNaN(config.pythonMaxRuns) ? Number.POSITIVE_INFINITY : config.pythonMaxRuns);

	const answer = yield* Deferred.make<boolean>();

	const checkNow = Effect.gen(function* () {
		if (!config.pythonEnabled) return false;
		const files = yield* Effect.tryPromise(async () => {
			await readFile(`${dir}node_modules/pyodide/pyodide.asm.wasm`);
			await readFile(`${dir}vendor/dill/__init__.py`);
		}).pipe(Effect.option);
		if (Option.isNone(files)) {
			yield* Effect.logWarning("python: the sandbox is not set up. Run `npm run sandbox:setup`. Python is off.");
			return false;
		}
		const version = yield* denoVersion(deno);
		if (Option.isNone(version)) yield* Effect.logWarning(`python: Deno was not found (${deno}). Set PONDER_DENO. Python is off.`);
		return Option.isSome(version);
	});
	const check = Effect.tap(checkNow, (on) => Deferred.succeed(answer, on));

	const runNow = (request: RunRequest) =>
		Effect.gen(function* () {
			const nonce = `${randomBytes(12).toString("hex")}:`;
			const run = yield* Effect.acquireRelease(
				Effect.sync(() =>
					startRun(
						spawn(
							deno,
							[
								"run",
								"--no-prompt",
								"--cached-only",
								`--allow-read=${dir}node_modules/pyodide,${dir}vendor`,
								"--v8-flags=--max-old-space-size=512",
								// deno.json in the folder maps "pyodide" to node_modules.
								`${dir}runner.ts`,
							],
							// No environment from the server: only what Deno needs to start.
							{
								cwd: dir,
								env: { PATH: config.path, DENO_DIR: Option.getOrElse(config.denoDir, () => `${dir}.deno`), NO_COLOR: "1" },
								stdio: ["pipe", "pipe", "pipe"],
								detached: true,
							},
						),
						JSON.stringify({ nonce, code: request.code, files: request.files, state: request.state }),
					),
				),
				// Interrupted, or stopped below: nothing the run started is left.
				(run) => (Deferred.isDoneUnsafe(run.closed) ? Effect.void : Effect.andThen(Effect.sync(() => run.kill()), Deferred.await(run.closed))),
			);

			// WebAssembly memory is outside V8's heap limit, so the process's resident memory is watched instead.
			const overMemory = Effect.gen(function* () {
				while (true) {
					yield* Effect.sleep(MEMORY_CHECK);
					if ((yield* residentKb(run.child.pid)) > memoryMb * 1024) return "memory" as const;
				}
			});
			const stopped = yield* Deferred.await(run.closed).pipe(
				Effect.as(undefined),
				Effect.raceFirst(overMemory),
				Effect.timeoutOrElse({ duration: RUN_TIMEOUT, orElse: () => Effect.succeed("time" as const) }),
			);
			if (stopped) {
				run.kill();
				yield* Deferred.await(run.closed);
			}

			const line = run.stdout.split("\n").find((text) => text.startsWith(nonce));
			const reply = line && !stopped ? decodeReply(line.slice(nonce.length)) : Option.none();
			if (Option.isSome(reply)) return reply.value as RunReply;
			const error =
				stopped === "time"
					? `The run was stopped after ${RUN_TIMEOUT_MS / 1000} seconds.`
					: stopped === "memory"
						? `The run was stopped: it used more than ${memoryMb} MB of memory.`
						: `The sandbox failed: ${run.stderr.trim().split("\n").slice(-3).join(" ") || "no reply"}`;
			return { ok: false, stdout: "", stderr: "", error, stopped, outputs: [], skippedOutputs: [], packages: [] } satisfies RunReply;
		}).pipe(Effect.scoped);

	// No span of its own: its wait goes on the caller's python.run span, as before.
	const run = Effect.fnUntraced(function* (request: RunRequest) {
		const asked = yield* Clock.currentTimeMillis;
		return yield* slots.withPermit(
			Effect.gen(function* () {
				yield* Tracing.annotate({ "ponder.wait_ms": (yield* Clock.currentTimeMillis) - asked });
				return yield* runNow(request);
			}),
		);
	});

	return Sandbox.of({
		enabled: config.pythonEnabled,
		check,
		ready: Deferred.await(answer),
		readyNow: Effect.flatMap(Deferred.isDone(answer), (done) => (done ? Effect.map(Deferred.await(answer), Option.some) : Effect.succeedNone)),
		turnOff: Effect.asVoid(Deferred.succeed(answer, false)),
		run,
	});
});

export const layer = Layer.effect(Sandbox, make);

type Run = { child: ChildProcessWithoutNullStreams; stdout: string; stderr: string; closed: Deferred.Deferred<void>; kill: () => void };

/** Listens to the process at once, so no output or exit comes before the listeners, and sends the request. */
function startRun(child: ChildProcessWithoutNullStreams, request: string): Run {
	const run: Run = {
		child,
		stdout: "",
		stderr: "",
		closed: Deferred.makeUnsafe<void>(),
		kill: () => {
			try {
				// The whole process group, so nothing it started is left.
				process.kill(-child.pid!, "SIGKILL");
			} catch {}
		},
	};
	child.stdout.on("data", (chunk) => (run.stdout += chunk));
	child.stderr.on("data", (chunk) => (run.stderr = (run.stderr + chunk).slice(-MAX_STDERR)));
	child.on("close", () => Deferred.doneUnsafe(run.closed, Effect.void));
	// Deno could not start: no close follows. The reply says the sandbox failed.
	child.on("error", () => Deferred.doneUnsafe(run.closed, Effect.void));
	// A process that ends before it reads its request closes the pipe: the reply says so.
	child.stdin.on("error", () => {});
	child.stdin.end(request);
	return run;
}

/** The process's resident memory in KB, or 0 once it is gone. */
const residentKb = (pid: number | undefined) =>
	Effect.tryPromise(() => readFile(`/proc/${pid}/status`, "utf8")).pipe(
		Effect.map((status) => Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0)),
		Effect.orElseSucceed(() => 0),
	);

/** Deno's version line, or none when it can't be run. */
const denoVersion = (deno: string) =>
	Effect.callback<Option.Option<string>>((resume) => {
		const child = spawn(deno, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.on("error", () => resume(Effect.succeed(Option.none())));
		child.on("close", (code) => resume(Effect.succeed(code === 0 ? Option.some(out.split("\n")[0]) : Option.none())));
	});
