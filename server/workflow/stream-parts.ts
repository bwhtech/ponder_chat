import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { TextStreamPart, ToolSet } from "ai";
import type { ModelToolCall } from "./model-call.ts";

/**
 * What a model call writes to the reply's durable stream: the parts that WorkflowAgent
 * wrote, which reply.ts turns into UI chunks (createModelCallToUIChunkTransform). Runs
 * that started before this loop replay the same way.
 *
 * Step and message boundaries are left out: the loop writes them (loop.ts). Errors are
 * left out too: the model step retries them, and a reply that still fails ends with its
 * own error (chat.ts). Values become plain data, because the stream is serialized.
 */
export function storedPart(part: TextStreamPart<ToolSet>): ModelCallStreamPart | undefined {
	switch (part.type) {
		case "text-start":
		case "text-end":
		case "reasoning-start":
		case "reasoning-end":
		case "text-delta":
		case "reasoning-delta":
		case "tool-input-start":
		case "tool-input-delta":
		case "source":
			return part as ModelCallStreamPart;
		case "tool-call":
			// An invalid call shows as an input error on the page (toUIMessageChunk), as WorkflowAgent showed it.
			return {
				type: "tool-call",
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				input: part.input,
				...(part.providerMetadata && { providerMetadata: part.providerMetadata }),
				...(part.invalid && { invalid: true, error: part.error instanceof Error ? part.error.message : String(part.error) }),
			} as ModelCallStreamPart;
		case "file":
			return { type: "file", file: { mediaType: part.file.mediaType, base64: part.file.base64 } } as ModelCallStreamPart;
		default:
			return undefined;
	}
}

/** A tool call as the loop gets it. An invalid call keeps the SDK's reason, and the input the assistant message has ({}). */
export function toolCallOf(part: Extract<TextStreamPart<ToolSet>, { type: "tool-call" }>): ModelToolCall {
	const call = { type: "tool-call" as const, toolCallId: part.toolCallId, toolName: part.toolName };
	if (!part.invalid) return { ...call, input: part.input };
	return { ...call, input: {}, invalid: part.error instanceof Error ? part.error.message : String(part.error ?? "The tool call is not valid.") };
}

/** Reset: the browser and saveReply drop what an earlier attempt at this model call wrote. */
export const RESET_STEP: ModelCallStreamPart = { type: "reset-step" };
/** Between model calls, after the tool results, as the AI SDK marks steps. */
export const STEP_BOUNDARY = [{ type: "finish-step" }, { type: "start-step" }] as unknown as ModelCallStreamPart[];

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
