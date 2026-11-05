import { loadFile, storeFile } from "../files.ts";
import { runPython, type SandboxFile } from "./pyodide.ts";
import type { RunPythonInput } from "./schema.ts";
import { loadPythonState, savePythonState } from "./state.ts";

/**
 * run_python: the model writes Python and Ponder Chat runs it in the sandbox (pyodide.ts).
 * The chat workflow (server/workflow/chat.ts) gives the model this description and input
 * schema, and runs `executeRunPython` as a durable step.
 * Attached files go in /work/inputs; files the code writes to /work/outputs come back
 * to the chat. Variables, imports and other files in /work stay for the next run in the
 * same chat. Runs in one chat take turns, so each starts from the state the last one left.
 */
/** What the model reads of stdout and stderr; the rest is cut. */
const MAX_MODEL_CHARS = 20_000;
const NAME = /^[a-z][a-z0-9_]{0,40}$/;


const queues = new Map<string, Promise<unknown>>();

/** Runs the model's code in the chat's sandbox and returns what the model reads. */
export async function executeRunPython({ code, inputs }: RunPythonInput, { threadId, owner }: { threadId: string; owner: string }) {
	const files: SandboxFile[] = [];
	const names = new Set<string>();
	for (const item of inputs) {
		if (!NAME.test(item.name)) return { error: `Input name "${item.name}" must be snake_case letters, digits and _.` };
		if (names.has(item.name)) return { error: `Two inputs are named "${item.name}".` };
		names.add(item.name);
		const file = await loadFile(item.file_id, owner);
		if (!file) return { error: `No attachment with id "${item.file_id}". Use the id its message names.` };
		const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") : "bin";
		files.push({ path: `/work/inputs/${item.name}.${extension}`, base64: file.data.toString("base64") });
	}

	// Runs in one chat take turns: each starts from the state the last one saved.
	const previous = queues.get(threadId) ?? Promise.resolve();
	const turn = previous.catch(() => undefined).then(async () => {
		const state = await loadPythonState(threadId, owner);
		const reply = await runPython({ code, files, state });
		if (reply.state) await savePythonState(threadId, owner, reply.state);
		return reply;
	});
	queues.set(threadId, turn);
	const reply = await turn;
	if (queues.get(threadId) === turn) queues.delete(threadId);

	const outputs = await Promise.all(
		reply.outputs.map(async (file) => {
			const name = file.path.split("/").pop() ?? file.path;
			const stored = await storeFile(owner, name, mediaTypeOf(name), Buffer.from(file.base64, "base64"));
			return { name: file.path, url: stored.url, media_type: stored.mediaType, size: stored.size };
		}),
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
}

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
