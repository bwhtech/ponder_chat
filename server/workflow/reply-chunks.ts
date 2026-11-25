import { toUIMessageChunk, type ModelCallStreamPart } from "@ai-sdk/workflow";
import type { UIMessageChunk } from "ai";
import { COMPACTION_MARKER } from "./stream-parts.ts";

export { COMPACTION_MARKER } from "./stream-parts.ts";
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
