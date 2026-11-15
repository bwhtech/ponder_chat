import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type { SqlError } from "effect/sql/SqlError";
import * as Files from "../files.ts";
import type { ObjectStoreError } from "../files/ObjectStore.ts";
import * as Tracing from "../tracing/Tracing.ts";
import * as Sandbox from "./pyodide.ts";
import type { SandboxFile } from "./pyodide.ts";
import type { RunPythonInput } from "./schema.ts";
import * as PythonState from "./state.ts";

/**
 * run_python: the model writes Python and Ponder Chat runs it in the sandbox (pyodide.ts).
 * The chat workflow (server/workflow/chat.ts) gives the model this description and input
 * schema, and runs `execute` as a durable step.
 * Attached files go in /work/inputs; files the code writes to /work/outputs come back
 * to the chat. Variables, imports and other files in /work stay for the next run in the
 * same chat. Runs in one chat take turns, so each starts from the state the last one left.
 */
/** What the model reads of stdout and stderr; the rest is cut. */
const MAX_MODEL_CHARS = 20_000;
const NAME = /^[a-z][a-z0-9_]{0,40}$/;

type Context_ = { threadId: string; owner: string };

/** What the model reads of a run: its output and files, or why it could not start. */
export type RunPythonResult =
	| { error: string }
	| {
			ok: boolean;
			error?: string;
			stdout: string;
			stderr: string;
			files: { name: string; url: string; media_type: string; size: number }[];
			skipped_files?: readonly string[];
			state_note?: string;
	  };

export class RunPython extends Context.Service<
	RunPython,
	{
		/** Runs the model's code in the chat's sandbox and returns what the model reads. */
		readonly execute: (input: RunPythonInput, context: Context_) => Effect.Effect<RunPythonResult, SqlError | ObjectStoreError>;
	}
>()("ponder/python/RunPython") {}

const make = Effect.gen(function* () {
	const files = yield* Files.Files;
	const sandbox = yield* Sandbox.Sandbox;
	const states = yield* PythonState.PythonState;
	const turns = yield* threadTurns;

	// The run's time, its wait for a slot (pyodide.ts) and how it ended, never the code or what it printed.
	const runInSandbox = Effect.fn("python.run")(function* (code: string, inputs: SandboxFile[], { threadId, owner }: Context_) {
		yield* Tracing.annotate({ "ponder.files": inputs.length });
		const state = yield* states.load(threadId, owner);
		const reply = yield* sandbox.run({ code, files: inputs, state: Option.getOrUndefined(state) });
		yield* Tracing.annotate({ "ponder.python.status": reply.stopped ?? (reply.ok ? "ok" : "error"), "ponder.outputs": reply.outputs.length });
		if (reply.state) yield* states.save(threadId, owner, reply.state);
		return reply;
	});

	const execute = Effect.fn("RunPython.execute")(function* ({ code, inputs }: RunPythonInput, context: Context_) {
		const sandboxFiles: SandboxFile[] = [];
		const names = new Set<string>();
		for (const item of inputs) {
			if (!NAME.test(item.name)) return { error: `Input name "${item.name}" must be snake_case letters, digits and _.` };
			if (names.has(item.name)) return { error: `Two inputs are named "${item.name}".` };
			names.add(item.name);
			const file = yield* files.load(item.file_id, context.owner);
			if (Option.isNone(file)) return { error: `No attachment with id "${item.file_id}". Use the id its message names.` };
			const { name, data } = file.value;
			const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") : "bin";
			sandboxFiles.push({ path: `/work/inputs/${item.name}.${extension}`, base64: data.toString("base64") });
		}

		// Runs in one chat take turns: each starts from the state the last one saved.
		const reply = yield* turns(context.threadId, runInSandbox(code, sandboxFiles, context));

		const outputs = yield* Effect.forEach(
			reply.outputs,
			Effect.fnUntraced(function* (file) {
				const name = file.path.split("/").pop() ?? file.path;
				const stored = yield* files.store(context.owner, name, mediaTypeOf(name), Buffer.from(file.base64, "base64"));
				return { name: file.path, url: stored.url, media_type: stored.mediaType, size: stored.size };
			}),
			{ concurrency: "unbounded" },
		);
		return {
			ok: reply.ok,
			...(reply.error && { error: cut(reply.error) }),
			// What the code printed is data from the run, not instructions.
			stdout: cut(reply.stdout),
			stderr: cut(reply.stderr),
			files: outputs,
			...(reply.skippedOutputs.length && { skipped_files: reply.skippedOutputs }),
			...(reply.stateNote && { state_note: reply.stateNote }),
		};
	});

	return RunPython.of({ execute });
});

export const layer = Layer.effect(RunPython, make);

/**
 * One turn at a time for each thread, in the order asked. A thread's lock is dropped
 * when nobody holds it or waits for it, so the map holds only threads with a run.
 */
const threadTurns = Effect.sync(() => {
	const locks = new Map<string, { lock: Semaphore.Semaphore; users: number }>();
	const acquire = (threadId: string) =>
		Effect.sync(() => {
			const entry = locks.get(threadId) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
			entry.users++;
			locks.set(threadId, entry);
			return entry;
		});
	const release = (threadId: string, entry: { users: number }) =>
		Effect.sync(() => {
			if (--entry.users === 0) locks.delete(threadId);
		});
	return <A, E, R>(threadId: string, turn: Effect.Effect<A, E, R>) =>
		Effect.acquireUseRelease(
			acquire(threadId),
			(entry) => entry.lock.withPermit(turn),
			(entry) => release(threadId, entry),
		);
});

function cut(text: string) {
	return text.length > MAX_MODEL_CHARS ? `${text.slice(0, MAX_MODEL_CHARS)}\n[cut: ${text.length - MAX_MODEL_CHARS} more characters]` : text;
}

const MEDIA_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	svg: "image/svg+xml",
	gif: "image/gif",
	webp: "image/webp",
	pdf: "application/pdf",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	txt: "text/plain",
	md: "text/markdown",
	json: "application/json",
	html: "text/html",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function mediaTypeOf(name: string) {
	return MEDIA_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}
