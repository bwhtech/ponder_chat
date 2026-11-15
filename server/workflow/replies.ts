import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { UIMessage, UIMessageChunk } from "ai";
import * as Option from "effect/Option";
import { getRun, start } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/errors";
import * as ModelCalls from "../telemetry/ModelCalls.ts";
import { isAuto } from "../../shared/auto-model.ts";
import * as AutoRouter from "../models/AutoRouter.ts";
import * as Models from "../models/Models.ts";
import * as PythonState from "../python/state.ts";
import { runPromise } from "../runtime/runtime.ts";
import { pythonReady } from "../startup.ts";
import * as ThreadCache from "../thread-cache.ts";
import * as Threads from "../threads/Threads.ts";
import { linkToReply, recordReplySpan, tracingOn, withReplyTrace } from "../tracing/reply-trace.ts";
import { approvalsUsedBy, forgetApprovalUses, releaseApprovals, useApprovals } from "./approval-uses.ts";
import { answersIn, settledChunks, stillAsked, withUncertainOutcomes, type Answer } from "./answered-again.ts";
import { chatTurn } from "./chat.ts";
import { replyStream, saveReply } from "./reply.ts";
import { activeRun, finishRun, forgetRuns, latestRun, setActiveRun, unfinishedRuns, withThreadLock, type Continued, type ThreadRun } from "./runs.ts";

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
	/** The same approval came twice, and this follows the run that carries it out, or carried it out. */
	followed: boolean;
};

/**
 * Saves the thread and starts a reply to it. A reply still running in the thread stops
 * first, and keeps what it wrote. null when the thread is someone else's.
 *
 * After an approval, the page sends the thread again with no new message: the run then
 * carries on the last assistant message. Each answer is used once: it must answer a
 * question that still waits in the saved thread, and its use is recorded before the run
 * starts (approval-uses.ts). An answer sent again, such as from a second tab, starts
 * nothing and saves nothing: the page gets the outcome, and reloads the thread
 * (answeredAgain).
 */
export async function startReply(input: { threadId: string; owner: string; messages: UIMessage[]; model?: string }): Promise<Started | null> {
	const { threadId, owner, messages } = input;
	const requested = Date.now();
	if (!(await mayUse(threadId, owner))) return null;
	const model = await runPromise(Models.Models.use((models) => models.pick(input.model)));
	const python = await pythonReady;
	const continued = continuedFrom(messages);
	const started = await withThreadLock(threadId, async () => {
		const previous = await activeRun(threadId);
		if (previous && sameContinuation(previous.continued, continued)) return { runId: previous.runId, model: previous.model, followed: true };
		// Before anything is stopped or saved: the stale page's thread must not replace the saved one.
		const asked = continued ? messages.at(-1)! : undefined;
		const answers = asked ? answersIn(asked) : [];
		if (asked && answers.length) {
			const saved = (await runPromise(Threads.Threads.use((threads) => threads.load(threadId)))).find((message) => message.id === asked.id && message.role === "assistant");
			if (!stillAsked(saved, answers) || !(await useApprovals(threadId, answers))) return answeredAgain(threadId, owner, asked, answers);
		}
		if (previous) await cancel(previous, owner);
		// A continued run is a trace of its own that links to the run it carries on (server/tracing/reply-trace.ts).
		const carriesOn = continued && tracingOn() ? (await latestRun(threadId))?.runId : undefined;
		let run: { runId: string };
		try {
			// The run reads the thread from the database, so it is saved first.
			await runPromise(Threads.Threads.use((threads) => threads.save(threadId, owner, messages)));
			// Under Auto, a reply carried on after an approval goes back to the model that wrote it.
			const answeredBy = continued && isAuto(model.id) ? Option.getOrUndefined(await runPromise(AutoRouter.AutoRouter.use((router) => router.lastAnsweringModel(threadId)))) : undefined;
			run = await start(chatTurn, [
				{ threadId, owner, model: { id: model.id, name: model.name }, python, today: new Date().toDateString(), maxSteps: MAX_STEPS, continued, answeredBy },
			]);
		} catch (error) {
			// No run carries the answers out, so the page may send them again.
			if (answers.length) await releaseApprovals(threadId, answers).catch(() => undefined);
			throw error;
		}
		if (answers.length) await approvalsUsedBy(threadId, answers, run.runId);
		await setActiveRun(threadId, run.runId, model.id, continued);
		recordReplySpan(run.runId, "chat.request", requested, Date.now(), { "ponder.continued": Boolean(continued) }, carriesOn ? [linkToReply(carriesOn)] : []);
		return { runId: run.runId, model: model.id, followed: false };
	});
	// The run goes on if the request closes; the page reconnects with followReply.
	const stream = "stream" in started ? started.stream : () => replyStream(started.runId, started.model, { continued });
	return { runId: started.runId, followed: started.followed, stream: await withReplyTrace(started.runId, stream) };
}

/**
 * What the page gets for answers that were used already, or that answer no question
 * waiting in the saved thread: no run starts, and nothing it sent is saved.
 *
 * An approved call whose run stopped or failed before its result (Stop, a crash) may or
 * may not have taken effect. It never runs again: when no run is going, the saved thread
 * says so in its place. The page gets each answer's outcome, so it does not send its
 * answers again, and a signal to load the thread as it is saved (THREAD_CHANGED).
 */
async function answeredAgain(threadId: string, owner: string, asked: UIMessage, answers: Answer[]) {
	console.warn(`replies: thread ${threadId} answered approvals that were used already or are not asked; nothing runs`);
	let messages = await runPromise(Threads.Threads.use((threads) => threads.load(threadId)));
	if (!(await activeRun(threadId))) {
		const at = messages.findIndex((message) => message.id === asked.id && message.role === "assistant");
		const settled = at === -1 ? undefined : withUncertainOutcomes(messages[at]!, answers);
		if (settled) {
			messages = messages.map((message, index) => (index === at ? settled : message));
			await runPromise(Threads.Threads.use((threads) => threads.update(threadId, owner, messages)));
		}
	}
	const saved = messages.find((message) => message.id === asked.id && message.role === "assistant");
	const latest = await latestRun(threadId);
	return { runId: latest?.runId ?? asked.id, model: latest?.model ?? "", followed: true, stream: async () => chunkStream(settledChunks(saved, asked)) };
}

function chunkStream(chunks: UIMessageChunk[]) {
	return new ReadableStream<UIMessageChunk>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
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
		if ((await ownerOf(threadId)) !== owner) return false;
		const run = await activeRun(threadId);
		if (run) await cancel(run, owner);
		if (!(await runPromise(Threads.Threads.use((threads) => threads.remove(threadId, owner))))) return false;
		await forgetRuns(threadId);
		await forgetApprovalUses(threadId);
		return true;
	});
	if (deleted) {
		await runPromise(ThreadCache.ThreadCache.use((cache) => cache.forget(threadId)));
		await runPromise(PythonState.PythonState.use((states) => states.forget(threadId, owner)));
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

/**
 * Finishes the runs that ended without saving their reply, so their thread does not look
 * busy forever. chatTurn saves the reply on every way out of its own code, but the
 * workflow runtime can fail a run outside it: a replay that diverged, such as a reply in
 * flight across a deploy that changed its steps. Run by the sweep (sweep.ts).
 *
 * The reply is saved as far as it got: marked failed, so the page offers Retry, or
 * cancelled, for a run that Stop cancelled and a crash kept from saving. The calls the run
 * had in flight cost no credits, and the sweep gets their cost. One run that fails to
 * finish does not keep the others waiting.
 */
export async function finishEndedRuns() {
	for (const run of await unfinishedRuns()) {
		try {
			await finishEndedRun(run);
		} catch (error) {
			console.error(`replies: could not finish run ${run.runId}:`, error instanceof Error ? error.message : error);
		}
	}
}

async function finishEndedRun(run: ThreadRun) {
	const status = await workflowStatus(run.runId);
	if (status === "pending" || status === "running") return;
	const cancelled = status === "cancelled";
	const failed = !cancelled && status !== "completed";
	// Inside the run's trace, so the reply.save span has its parent (server/tracing/reply-trace.ts).
	await withThreadLock(run.threadId, () =>
		withReplyTrace(run.runId, async () => {
			if ((await activeRun(run.threadId))?.runId !== run.runId) return;
			console.warn(`replies: run ${run.runId} ended (${status}) without saving its reply; saving what it wrote`);
			try {
				if (cancelled) await runPromise(ModelCalls.ModelCalls.use((calls) => calls.stop(run.threadId, run.runId)));
				else await runPromise(ModelCalls.ModelCalls.use((calls) => calls.settle(run.threadId, run.runId)));
				// Before the save, as chatTurn does (endReplyStream), so the saved reply ends where the page's does.
				await endStream(run.runId, failed ? ENDED_ERROR : undefined);
				const owner = await ownerOf(run.threadId);
				if (owner) await saveReply(run.threadId, owner, run.runId, run.model, { cancelled, failed, continued: run.continued });
			} finally {
				// Finished even when the save fails, so the thread does not look busy forever.
				await finishRun(run.threadId, run.runId, run.model, { cancelled, failed, continued: run.continued });
			}
		}),
	);
}

/** What a page reads at the end of a reply whose run ended without saving it. */
const ENDED_ERROR = "This reply could not finish. Retry, or choose another model.";

/**
 * Ends the stream of a run that ended without ending it, as endReplyStream does in the
 * run: with the error for a failed run. A page that still follows the reply, such as one
 * open during a deploy, then stops and offers Retry without a reload. A run the runtime
 * no longer has, or a stream it refuses, is logged: the reply is saved either way.
 */
async function endStream(runId: string, error?: string) {
	try {
		const writable = getRun(runId).getWritable<ModelCallStreamPart>();
		const writer = writable.getWriter();
		try {
			if (error) await writer.write({ type: "error", error });
		} finally {
			writer.releaseLock();
		}
		await writable.close();
	} catch (cause) {
		console.warn(`replies: could not end the stream of run ${runId}:`, cause instanceof Error ? cause.message : cause);
	}
}

/** The workflow run's status, or "gone" when the runtime has no such run. */
async function workflowStatus(runId: string) {
	try {
		return await getRun(runId).status;
	} catch (error) {
		if (WorkflowRunNotFoundError.is(error)) return "gone";
		throw error;
	}
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
		// The model call in flight runs to its end on OpenRouter; it costs the person no credits.
		await runPromise(ModelCalls.ModelCalls.use((calls) => calls.stop(run.threadId, run.runId))).catch((error) => console.warn(`replies: could not mark the calls of run ${run.runId} stopped:`, error));
	}
}

/** The person's thread, or a thread id nobody has taken yet. */
async function mayUse(threadId: string, owner: string) {
	return ((await ownerOf(threadId)) ?? owner) === owner;
}

/** Whose thread this is, or undefined for a new one. */
async function ownerOf(threadId: string) {
	return Option.getOrUndefined(await runPromise(Threads.Threads.use((threads) => threads.owner(threadId))));
}

/** A thread that ends on an assistant message carries on that message (an approval was answered). */
function continuedFrom(messages: UIMessage[]): Continued | null {
	const last = messages.at(-1);
	return last?.role === "assistant" ? { messageId: last.id, baseParts: last.parts.length } : null;
}

function sameContinuation(running: Continued | null, asked: Continued | null) {
	return Boolean(asked && running?.messageId === asked.messageId && running.baseParts === asked.baseParts);
}
