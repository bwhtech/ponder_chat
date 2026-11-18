import type { UIMessageChunk } from "ai";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Memory from "../memory.ts";
import { problem } from "../runtime/Database.ts";
import * as ModelCalls from "../telemetry/ModelCalls.ts";
import * as Threads from "../threads/Threads.ts";
import * as Tracing from "../tracing/Tracing.ts";
import { replayReply } from "./replay.ts";
import { toUIChunks } from "./reply-chunks.ts";
import * as ThreadRuns from "./runs.ts";
import type { Continued } from "./runs.ts";
import * as WorkflowRuns from "./WorkflowRuns.ts";

/** The reply's message id: the same in the live stream, a reconnect, and the saved thread. */
export const messageIdFor = (runId: string) => `msg-${runId}`;

/**
 * A run's stream as UI chunks (reply-chunks.ts), from the start. The durable stream holds raw model parts,
 * so a reconnect replays them all and skips the UI chunks the browser already has.
 * With `untilTail`, the stream ends at what the run has written so far, instead of
 * when the run closes it: a cancelled run never closes its stream.
 *
 * No span of its own: a route runs it inside the reply's trace, and Workflow's spans of the read are the reply's.
 */
export const replyStream = Effect.fnUntraced(function* (
	runId: string,
	model: string,
	{ uiStartIndex = 0, untilTail = false, continued = null }: { uiStartIndex?: number; untilTail?: boolean; continued?: Continued | null } = {},
) {
	const readable = yield* WorkflowRuns.WorkflowRuns.use((runs) => runs.readable(runId));
	const raw = untilTail ? firstChunks(readable, (yield* Effect.promise(() => readable.getTailIndex())) + 1) : readable;
	// A run that carries on a message keeps its id, so the page and the saved thread extend that message.
	const messageId = continued?.messageId ?? messageIdFor(runId);
	return raw.pipeThrough(toUIChunks({ uiStartIndex })).pipeThrough(withMessage(messageId, model));
});

/** The first `count` chunks of a stream, then the end. */
function firstChunks<T>(source: ReadableStream<T>, count: number) {
	const reader = source.getReader();
	let read = 0;
	return new ReadableStream<T>({
		async pull(controller) {
			if (read >= count) {
				controller.close();
				// The stream's own edge: what was read is all that is wanted, so a cancel that fails changes nothing.
				await reader.cancel().catch(() => undefined);
				return;
			}
			const { done, value } = await reader.read();
			if (done) return controller.close();
			read++;
			controller.enqueue(value);
		},
		cancel: () => reader.cancel(),
	});
}

/** Gives the `start` chunk a stable message id, and the model that wrote the reply. */
function withMessage(messageId: string, model: string) {
	return new TransformStream<UIMessageChunk, UIMessageChunk>({
		transform: (chunk, controller) => controller.enqueue(chunk.type === "start" ? { ...chunk, messageId, messageMetadata: { model } } : chunk),
	});
}

export type SaveOptions = { cancelled?: boolean; failed?: boolean; continued?: Continued | null };

/** Parts that say how the reply went, not what it said. */
const STATUS_PARTS = new Set(["step-start", "data-compaction"]);

/**
 * Saves what the run wrote as the thread's last message. The reply loop keeps model
 * messages, with no conversion back to UI messages, so this replays the run's own
 * stream into a UI message, as the browser did. Used by the run's last step, and by Stop
 * for a run cut short (`cancelled`: what it wrote up to the moment it was stopped). A
 * `failed` run is saved the same way, and marked so the page offers Retry (runs.ts).
 * The reply replaces a message with the same id, so saving twice is safe.
 * Memory then decides, in the background, what the turn adds (server/memory.ts).
 */
// The span's name and attribute are the ones the reply's save always had: tracing.spec.ts looks for them.
export const saveReply = Effect.fn("reply.save")(function* (threadId: string, owner: string, runId: string, model: string, { cancelled = false, failed = false, continued = null }: SaveOptions = {}) {
	yield* Tracing.annotate({ "ponder.outcome": cancelled ? "cancelled" : failed ? "failed" : "saved" });
	const threads = yield* Threads.Threads;
	const untilTail = cancelled || failed;
	const messages = yield* threads.load(threadId);
	// After the person answers an approval, the run carries on the thread's last assistant
	// message, as the browser does: its stream starts with the results of the approved
	// tools, for calls made in that message. The stream replays on that message as it was
	// before the run (its first `baseParts` parts), so saving twice adds nothing twice.
	const existing = continued && messages.find((message) => message.id === continued.messageId && message.role === "assistant");
	const base = existing ? { ...existing, parts: existing.parts.slice(0, continued.baseParts) } : undefined;
	// A stream that fails to read fails here, before anything is written (replay.ts).
	const stream = yield* replyStream(runId, model, { untilTail, continued });
	const reply = yield* Effect.promise(() => replayReply(stream, base));
	// A reply with only status parts, such as one stopped while it compacted, is not saved: as one stopped before any output.
	if (reply?.parts.some((part) => !STATUS_PARTS.has(part.type))) {
		const at = messages.findIndex((message) => message.id === reply.id);
		if (at === -1) messages.push(reply);
		else messages[at] = reply;
		// Only into the thread as it is: a thread deleted while the reply was written stays deleted.
		if (yield* threads.update(threadId, owner, messages)) {
			// It starts the save in the background, and does not wait for it.
			yield* Memory.Memory.use((memory) => memory.rememberTurn({ threadId, user: owner }, messages));
		}
	}
	yield* ThreadRuns.ThreadRuns.use((runs) => runs.finish(threadId, runId, model, { cancelled, failed, continued }));
});

/**
 * The run's last step (saveReplyStep): settles its model calls, then saves its reply.
 * Untraced, so reply.save stays the step's child.
 */
export const saveRunReply = Effect.fnUntraced(function* (threadId: string, owner: string, runId: string, model: string, options: SaveOptions) {
	yield* settleModelCalls(threadId, runId);
	yield* saveReply(threadId, owner, runId, model, options);
});

/** Marks the run finished, and failed, when saving its reply failed, so the thread does not look busy forever (finishRunStep). */
export const finishFailedRun = Effect.fnUntraced(function* (threadId: string, runId: string, model: string, continued: Continued | null) {
	yield* settleModelCalls(threadId, runId);
	yield* ThreadRuns.ThreadRuns.use((runs) => runs.finish(threadId, runId, model, { failed: true, continued }));
});

/**
 * Settles the run's model calls that a crash cut short on their last attempt (telemetry/ModelCalls.ts):
 * nothing ran again to settle them. They are not charged, and the sweep gets their cost.
 * A failure is logged: the reply is saved either way.
 */
const settleModelCalls = (threadId: string, runId: string) =>
	ModelCalls.ModelCalls.use((calls) => calls.settle(threadId, runId)).pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logWarning(`steps: could not settle the model calls of run ${runId}:`, problem(Cause.squash(cause))),
		),
	);
