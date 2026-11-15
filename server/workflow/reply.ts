import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { UIMessageChunk } from "ai";
import { getRun } from "workflow/api";
import { rememberTurn } from "../memory.ts";
import { runPromise } from "../runtime/runtime.ts";
import * as Threads from "../threads/Threads.ts";
import { replayReply } from "./replay.ts";
import { toUIChunks } from "./reply-chunks.ts";
import { finishRun, type Continued } from "./runs.ts";
import { span } from "../tracing/span.ts";

/** The reply's message id: the same in the live stream, a reconnect, and the saved thread. */
export const messageIdFor = (runId: string) => `msg-${runId}`;

/**
 * A run's stream as UI chunks (reply-chunks.ts), from the start. The durable stream holds raw model parts,
 * so a reconnect replays them all and skips the UI chunks the browser already has.
 * With `untilTail`, the stream ends at what the run has written so far, instead of
 * when the run closes it: a cancelled run never closes its stream.
 */
export async function replyStream(runId: string, model: string, { uiStartIndex = 0, untilTail = false, continued = null as Continued | null } = {}) {
	const readable = getRun(runId).getReadable<ModelCallStreamPart>({ startIndex: 0 });
	const raw = untilTail ? firstChunks(readable, (await readable.getTailIndex()) + 1) : readable;
	// A run that carries on a message keeps its id, so the page and the saved thread extend that message.
	const messageId = continued?.messageId ?? messageIdFor(runId);
	return raw.pipeThrough(toUIChunks({ uiStartIndex })).pipeThrough(withMessage(messageId, model));
}

/** The first `count` chunks of a stream, then the end. */
function firstChunks<T>(source: ReadableStream<T>, count: number) {
	const reader = source.getReader();
	let read = 0;
	return new ReadableStream<T>({
		async pull(controller) {
			if (read >= count) {
				controller.close();
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

/**
 * Saves what the run wrote as the thread's last message. The reply loop keeps model
 * messages, with no conversion back to UI messages, so this replays the run's own
 * stream into a UI message, as the browser did. Used by the run's last step, and by Stop
 * for a run cut short (`cancelled`: what it wrote up to the moment it was stopped). A
 * `failed` run is saved the same way, and marked so the page offers Retry (runs.ts).
 * The reply replaces a message with the same id, so saving twice is safe.
 * Memory then decides, in the background, what the turn adds (server/memory.ts).
 */
export async function saveReply(
	threadId: string,
	owner: string,
	runId: string,
	model: string,
	{ cancelled = false, failed = false, continued = null as Continued | null } = {},
) {
	await span("reply.save", { "ponder.outcome": cancelled ? "cancelled" : failed ? "failed" : "saved" }, () => saveReplyNow(threadId, owner, runId, model, { cancelled, failed, continued }));
}

/** Parts that say how the reply went, not what it said. */
const STATUS_PARTS = new Set(["step-start", "data-compaction"]);

async function saveReplyNow(threadId: string, owner: string, runId: string, model: string, { cancelled, failed, continued }: { cancelled: boolean; failed: boolean; continued: Continued | null }) {
	const untilTail = cancelled || failed;
	const messages = await runPromise(Threads.Threads.use((threads) => threads.load(threadId)));
	// After the person answers an approval, the run carries on the thread's last assistant
	// message, as the browser does: its stream starts with the results of the approved
	// tools, for calls made in that message. The stream replays on that message as it was
	// before the run (its first `baseParts` parts), so saving twice adds nothing twice.
	const existing = continued && messages.find((message) => message.id === continued.messageId && message.role === "assistant");
	const base = existing ? { ...existing, parts: existing.parts.slice(0, continued.baseParts) } : undefined;
	// A stream that fails to read throws here, before anything is written (replay.ts).
	const reply = await replayReply(await replyStream(runId, model, { untilTail, continued }), base);
	// A reply with only status parts, such as one stopped while it compacted, is not saved: as one stopped before any output.
	if (reply?.parts.some((part) => !STATUS_PARTS.has(part.type))) {
		const at = messages.findIndex((message) => message.id === reply.id);
		if (at === -1) messages.push(reply);
		else messages[at] = reply;
		// Only into the thread as it is: a thread deleted while the reply was written stays deleted.
		if (await runPromise(Threads.Threads.use((threads) => threads.update(threadId, owner, messages)))) rememberTurn({ threadId, user: owner }, messages);
	}
	await finishRun(threadId, runId, model, { cancelled, failed, continued });
}
