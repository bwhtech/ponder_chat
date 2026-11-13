import { toUIMessageChunk, type ModelCallStreamPart } from "@ai-sdk/workflow";
import type { UIMessageChunk } from "ai";

/**
 * A run's raw stream as UI chunks: createModelCallToUIChunkTransform from
 * @ai-sdk/workflow, plus Ponder's compaction status. compactStep writes the status as a
 * `raw` part, which the library's transform drops; here it becomes a `data-compaction`
 * part with a fixed id, so "done" replaces "running" in the message. It is saved with the
 * reply, and convertToModelMessages leaves it out, so the model never reads it.
 *
 * The chunks are counted the same way as the library does, so a reconnect that skips
 * `uiStartIndex` chunks lines up. No Node imports: the workflow's steps import the marker.
 */
export const COMPACTION_MARKER = "ponderCompaction";
export const COMPACTION_PART = "data-compaction";

export function toUIChunks({ uiStartIndex = 0 } = {}) {
	let index = 0;
	const enqueue = (controller: TransformStreamDefaultController<UIMessageChunk>, chunk: UIMessageChunk) => {
		if (index++ >= uiStartIndex) controller.enqueue(chunk);
	};
	return new TransformStream<ModelCallStreamPart, UIMessageChunk>({
		start: (controller) => {
			enqueue(controller, { type: "start" });
			enqueue(controller, { type: "start-step" });
		},
		flush: (controller) => {
			enqueue(controller, { type: "finish-step" });
			enqueue(controller, { type: "finish" });
		},
		transform: (part, controller) => {
			const chunk = compactionChunk(part) ?? toUIMessageChunk(part);
			if (chunk) enqueue(controller, chunk);
		},
	});
}

function compactionChunk(part: ModelCallStreamPart): UIMessageChunk | undefined {
	if (part.type !== "raw") return undefined;
	const state = (part.rawValue as Record<string, unknown> | null)?.[COMPACTION_MARKER];
	if (!state || typeof state !== "object") return undefined;
	return { type: COMPACTION_PART, id: "compaction", data: state };
}

type ToolInputDelta = Extract<UIMessageChunk, { type: "tool-input-delta" }>;

/**
 * Joins each run of consecutive tool-input-delta chunks of one tool call into one chunk,
 * for saveReply (reply.ts). For each delta, the AI SDK's readUIMessageStream parses the
 * whole input so far, so a long input in many small pieces took time quadratic in its
 * length, on the event loop: 400 KB in 40-character pieces held the server for about 20
 * seconds. The message is the same, because only the last parse of an input is kept.
 *
 * Text deltas stay as they are: they cost little, and joined they did not save the same
 * message. The live stream is not joined either: a reconnect counts its chunks.
 */
export function joinToolInputDeltas() {
	let pending: { chunk: ToolInputDelta; pieces: string[] } | undefined;
	const release = (controller: TransformStreamDefaultController<UIMessageChunk>) => {
		if (pending) controller.enqueue({ ...pending.chunk, inputTextDelta: pending.pieces.join("") });
		pending = undefined;
	};
	return new TransformStream<UIMessageChunk, UIMessageChunk>({
		transform: (chunk, controller) => {
			if (chunk.type === "tool-input-delta" && pending?.chunk.toolCallId === chunk.toolCallId) {
				pending.pieces.push(chunk.inputTextDelta);
				return;
			}
			release(controller);
			if (chunk.type === "tool-input-delta") pending = { chunk, pieces: [chunk.inputTextDelta] };
			else controller.enqueue(chunk);
		},
		flush: release,
	});
}
