import type { UIMessage } from "ai";
import { getRun, start } from "workflow/api";
import { deleteThread, saveThread, threadOwner } from "../db.ts";
import { pickModel } from "../models.ts";
import { forgetPythonState } from "../python/state.ts";
import { pythonReady } from "../startup.ts";
import { forgetThread } from "../thread-cache.ts";
import { linkToReply, recordReplySpan, tracingOn, withReplyTrace } from "../tracing/reply-trace.ts";
import { chatTurn } from "./chat.ts";
import { replyStream, saveReply } from "./reply.ts";
import { activeRun, finishRun, forgetRuns, latestRun, setActiveRun, withThreadLock, type Continued, type ThreadRun } from "./runs.ts";

/**
 * A reply's whole life, for the routes (app.ts): start it, follow it, stop it, and delete
 * its thread. Each reply is a durable workflow run (chat.ts); runs.ts tracks each
 * thread's latest run.
 *
 * Every function takes the signed-in person and acts only on their thread, or on a new
 * thread id that nobody has taken. Starting, stopping and deleting take the thread's lock
 * (runs.ts), so a double submit or a second tab never leaves a run going that nobody
 * tracks and Stop can't reach.
 */
const MAX_STEPS = Number(process.env.CHAT_MAX_STEPS ?? 10);

export type Reply = { runId: string; stream: ReadableStream };
export type Started = Reply & {
	/** The same approval came twice, and this follows the run that carries it out. */
	followed: boolean;
};

/**
 * Saves the thread and starts a reply to it. A reply still running in the thread stops
 * first, and keeps what it wrote. null when the thread is someone else's.
 *
 * After an approval, the page sends the thread again with no new message: the run then
 * carries on the last assistant message.
 */
export async function startReply(input: { threadId: string; owner: string; messages: UIMessage[]; model?: string }): Promise<Started | null> {
	const { threadId, owner, messages } = input;
	const requested = Date.now();
	if (!(await mayUse(threadId, owner))) return null;
	const model = await pickModel(input.model);
	const python = await pythonReady;
	const continued = continuedFrom(messages);
	const started = await withThreadLock(threadId, async () => {
		const previous = await activeRun(threadId);
		if (previous && sameContinuation(previous.continued, continued)) return { runId: previous.runId, model: previous.model, followed: true };
		if (previous) await cancel(previous, owner);
		// A continued run is a trace of its own that links to the run it carries on (server/tracing/reply-trace.ts).
		const carriesOn = continued && tracingOn() ? (await latestRun(threadId))?.runId : undefined;
		// The run reads the thread from the database, so it is saved first.
		await saveThread(threadId, owner, messages);
		const run = await start(chatTurn, [
			{ threadId, owner, model: { id: model.id, name: model.name }, python, today: new Date().toDateString(), maxSteps: MAX_STEPS, continued },
		]);
		await setActiveRun(threadId, run.runId, model.id, continued);
		recordReplySpan(run.runId, "chat.request", requested, Date.now(), { "ponder.continued": Boolean(continued) }, carriesOn ? [linkToReply(carriesOn)] : []);
		return { runId: run.runId, model: model.id, followed: false };
	});
	// The run goes on if the request closes; the page reconnects with followReply.
	return { ...started, stream: await withReplyTrace(started.runId, () => replyStream(started.runId, started.model, { continued })) };
}

/**
 * The latest reply of a thread, by the thread id (a reloaded page) or the run id (a
 * dropped connection), from `uiStartIndex` (the UI chunks the page has). A finished run
 * replays to its end. null when there is no run, or it is not the person's.
 */
export async function followReply(id: string, owner: string, uiStartIndex = 0): Promise<Reply | null> {
	const run = await latestRun(id);
	if (!run || !(await mayUse(run.threadId, owner))) return null;
	const stream = await withReplyTrace(run.runId, () =>
		replyStream(run.runId, run.model, { uiStartIndex, untilTail: run.cancelled || run.failed, continued: run.continued }),
	);
	return { runId: run.runId, stream };
}

/** Stops the thread's reply and saves what it wrote. False when no reply was running. */
export async function stopReply(threadId: string, owner: string): Promise<boolean> {
	if (!(await mayUse(threadId, owner))) return false;
	return withThreadLock(threadId, async () => {
		const run = await activeRun(threadId);
		if (run) await cancel(run, owner);
		return Boolean(run);
	});
}

/** Deletes the person's thread, after its reply stops. What the reply writes after this is not saved (reply.ts). */
export async function deleteChat(threadId: string, owner: string): Promise<boolean> {
	const deleted = await withThreadLock(threadId, async () => {
		if ((await threadOwner(threadId)) !== owner) return false;
		const run = await activeRun(threadId);
		if (run) await cancel(run, owner);
		if (!(await deleteThread(threadId, owner))) return false;
		await forgetRuns(threadId);
		return true;
	});
	if (deleted) {
		forgetThread(threadId);
		await forgetPythonState(threadId, owner);
	}
	return deleted;
}

/**
 * Waits until the thread has no reply running, or `timeoutMs` passes. The page sees the
 * stream end a moment before the run's last step saves the reply.
 */
export async function whenReplyFinished(threadId: string, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while ((await activeRun(threadId)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
}

/** Cancels a run and saves what it wrote so far, inside the run's trace (server/tracing/reply-trace.ts). */
async function cancel(run: ThreadRun, owner: string) {
	await withReplyTrace(run.runId, () => cancelNow(run, owner));
}

async function cancelNow(run: ThreadRun, owner: string) {
	// A failed cancel still saves the reply below, but the run may write on, so it is logged.
	await getRun(run.runId)
		.cancel({ cancelReason: "Stopped by the person, or replaced by a newer message." })
		.catch((error) => console.warn(`replies: could not cancel run ${run.runId}:`, error instanceof Error ? error.message : error));
	// The step in flight writes on for a moment after a cancel, and the stream is never
	// closed, so the saved reply is what the run had written when it was stopped.
	// Finished even when the save fails, so the thread does not look busy forever.
	try {
		await saveReply(run.threadId, owner, run.runId, run.model, { cancelled: true, continued: run.continued });
	} finally {
		await finishRun(run.threadId, run.runId, run.model, { cancelled: true, continued: run.continued });
	}
}

/** The person's thread, or a thread id nobody has taken yet. */
async function mayUse(threadId: string, owner: string) {
	return ((await threadOwner(threadId)) ?? owner) === owner;
}

/** A thread that ends on an assistant message carries on that message (an approval was answered). */
function continuedFrom(messages: UIMessage[]): Continued | null {
	const last = messages.at(-1);
	return last?.role === "assistant" ? { messageId: last.id, baseParts: last.parts.length } : null;
}

function sameContinuation(running: Continued | null, asked: Continued | null) {
	return Boolean(asked && running?.messageId === asked.messageId && running.baseParts === asked.baseParts);
}
