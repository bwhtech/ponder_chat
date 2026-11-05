import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RUN_TIMEOUT_MS } from "./schema.ts";

/**
 * Runs Python in Pyodide inside a Deno process with no permissions (sandbox/pyodide/runner.ts),
 * one process per run, as LangChain's pyodide-sandbox does. This file starts the process,
 * passes the request on stdin, and ends the process when the run is over its time or
 * memory limit. Runs take turns: at most PYTHON_MAX_RUNS at once on the server.
 *
 * Deno's permissions are the wall: the process may only read Pyodide and the vendored
 * packages. It gets no environment from the server (no keys), no network, no writes
 * and no subprocesses. setup.sh must have run once (`npm run sandbox:setup`).
 */
// From the project folder, not this file: the server runs bundled from .output/.
const DIR = `${resolve(process.env.SEVA_SANDBOX_DIR ?? "sandbox/pyodide")}/`;
const DENO = process.env.SEVA_DENO ?? "deno";
const MAX_RUNS = Number(process.env.PYTHON_MAX_RUNS ?? 3);
const MEMORY_MB = Number(process.env.PYTHON_MEMORY_MB ?? 1536);

export type SandboxFile = { path: string; base64: string };
export type PythonState = { globals?: string; imports: string[]; files: SandboxFile[] };
export type RunRequest = { code: string; files?: SandboxFile[]; state?: PythonState; abortSignal?: AbortSignal };
export type RunReply = {
	ok: boolean;
	stdout: string;
	stderr: string;
	error?: string;
	/** Set when the server stopped the run: "time" or "memory". */
	stopped?: "time" | "memory";
	outputs: SandboxFile[];
	skippedOutputs: string[];
	state?: PythonState;
	stateNote?: string;
	packages: string[];
};

/** Python is on when the sandbox is set up and SEVA_PYTHON is not "off". */
export const pythonEnabled = process.env.SEVA_PYTHON !== "off";

/** Checks at start-up that Deno and the cached packages are there. Turns Python off with a log line if not. */
export async function checkSandbox(): Promise<boolean> {
	if (!pythonEnabled) return false;
	try {
		await readFile(`${DIR}node_modules/pyodide/pyodide.asm.wasm`);
		await readFile(`${DIR}vendor/dill/__init__.py`);
	} catch {
		console.warn("python: the sandbox is not set up. Run `npm run sandbox:setup`. Python is off.");
		return false;
	}
	const version = await new Promise<string | undefined>((resolve) => {
		const child = spawn(DENO, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.on("error", () => resolve(undefined));
		child.on("close", (code) => resolve(code === 0 ? out.split("\n")[0] : undefined));
	});
	if (!version) console.warn(`python: Deno was not found (${DENO}). Set SEVA_DENO. Python is off.`);
	return Boolean(version);
}

let running = 0;
const waiting: (() => void)[] = [];

export async function runPython(request: RunRequest): Promise<RunReply> {
	if (running >= MAX_RUNS) await new Promise<void>((resolve) => waiting.push(resolve));
	running++;
	try {
		return await runNow(request);
	} finally {
		running--;
		waiting.shift()?.();
	}
}

function runNow({ code, files, state, abortSignal }: RunRequest): Promise<RunReply> {
	const nonce = `${randomBytes(12).toString("hex")}:`;
	const child = spawn(
		DENO,
		[
			"run",
			"--no-prompt",
			"--cached-only",
			`--allow-read=${DIR}node_modules/pyodide,${DIR}vendor`,
			"--v8-flags=--max-old-space-size=512",
			// deno.json in DIR maps "pyodide" to node_modules.
			`${DIR}runner.ts`,
		],
		// No environment from the server: only what Deno needs to start.
		{ cwd: DIR, env: { PATH: process.env.PATH ?? "", DENO_DIR: process.env.SEVA_DENO_DIR ?? `${DIR}.deno`, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"], detached: true },
	);

	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let stopped: RunReply["stopped"];
		const kill = (reason?: RunReply["stopped"]) => {
			stopped ??= reason;
			try {
				// The whole process group, so nothing it started is left.
				process.kill(-child.pid!, "SIGKILL");
			} catch {}
		};
		const timer = setTimeout(() => kill("time"), RUN_TIMEOUT_MS);
		// WebAssembly memory is outside V8's heap limit, so the process's resident memory is watched instead.
		const watch = setInterval(async () => {
			const status = await readFile(`/proc/${child.pid}/status`, "utf8").catch(() => "");
			const kb = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0);
			if (kb > MEMORY_MB * 1024) kill("memory");
		}, 250);
		const onAbort = () => kill();
		abortSignal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-20_000)));
		child.on("close", () => {
			clearTimeout(timer);
			clearInterval(watch);
			abortSignal?.removeEventListener("abort", onAbort);
			const line = stdout.split("\n").find((text) => text.startsWith(nonce));
			if (line && !stopped) return resolve(JSON.parse(line.slice(nonce.length)) as RunReply);
			const error =
				stopped === "time"
					? `The run was stopped after ${RUN_TIMEOUT_MS / 1000} seconds.`
					: stopped === "memory"
						? `The run was stopped: it used more than ${MEMORY_MB} MB of memory.`
						: `The sandbox failed: ${stderr.trim().split("\n").slice(-3).join(" ") || "no reply"}`;
			resolve({ ok: false, stdout: "", stderr: "", error, stopped, outputs: [], skippedOutputs: [], packages: [] });
		});
		child.stdin.end(JSON.stringify({ nonce, code, files, state }));
	});
}
