import { createModelCallToUIChunkTransform, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { getRun } from "workflow/api";
import { loadThread, saveThread } from "../db.ts";
import { finishRun } from "./runs.ts";

/** The reply's message id: the same in the live stream, a reconnect, and the saved thread. */
export const messageIdFor = (runId: string) => `msg-${runId}`;

/**
 * A run's stream as UI chunks, from the start. The durable stream holds raw model parts,
 * so a reconnect replays them all and skips the UI chunks the browser already has.
 * With `untilTail`, the stream ends at what the run has written so far, instead of
 * when the run closes it: a cancelled run never closes its stream.
 */
export async function replyStream(runId: string, model: string, { uiStartIndex = 0, untilTail = false } = {}) {
	const readable = getRun(runId).getReadable<ModelCallStreamPart>({ startIndex: 0 });
	const raw = untilTail ? firstChunks(readable, (await readable.getTailIndex()) + 1) : readable;
	return raw.pipeThrough(createModelCallToUIChunkTransform({ uiStartIndex })).pipeThrough(withMessage(messageIdFor(runId), model));
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
 * Saves what the run wrote as the thread's last message. WorkflowAgent returns model
 * messages, with no conversion back to UI messages, so this replays the run's own
 * stream into a UI message, as the browser did. Used by the run's last step, and by Stop
 * for a run cut short (`untilTail`: what it wrote up to the moment it was stopped). The reply replaces a message with the same id, so saving twice is safe.
 */
export async function saveReply(threadId: string, owner: string, runId: string, model: string, { untilTail = false } = {}) {
	let reply: UIMessage | undefined;
	for await (const message of readUIMessageStream({ stream: await replyStream(runId, model, { untilTail }) })) reply = message;
	const messages = await loadThread(threadId);
	if (reply?.parts.length) {
		const at = messages.findIndex((message) => message.id === reply.id);
		if (at === -1) messages.push(reply);
		else messages[at] = reply;
		await saveThread(threadId, owner, messages);
	}
	await finishRun(threadId, runId, { cancelled: untilTail });
}
