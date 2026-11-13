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
