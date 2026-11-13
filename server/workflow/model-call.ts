import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { JSONSchema7, ModelMessage, ToolCallPart } from "ai";
import { MODEL_CALL_ATTEMPTS } from "./model-errors.ts";

/** A tool as the model sees it: no `execute`, so the model step only asks for calls. The loop runs them (loop.ts). */
export type ToolSpec = { name: string; description?: string; inputSchema: JSONSchema7 };

export type ModelCall = {
	runId: string;
	threadId: string;
	owner: string;
	modelId: string;
	instructions: string;
	messages: ModelMessage[];
	tools: ToolSpec[];
};

/**
 * A tool call the model asked for. `invalid` is the AI SDK's reason when the call can't
 * run: a tool that does not exist, or input that is not JSON (such as input cut by the
 * output limit). The loop gives the model that reason, and runs nothing.
 */
export type ModelToolCall = ToolCallPart & { invalid?: string };

export type ModelResponse = {
	/** The assistant message, to add to the conversation. The loop adds every tool result. */
	messages: ModelMessage[];
	toolCalls: ModelToolCall[];
	finishReason: string;
};

/**
 * One model call of a reply, as a durable step: it streams the model's output to the
 * page and returns the response (model-attempt.ts). Each attempt starts with
 * `reset-step`, so the page drops what an earlier attempt wrote.
 *
 * The step has MODEL_CALL_ATTEMPTS attempts, for errors and for a server that stopped
 * in the middle (a crash, a deploy, a restart). The attempt decides whether an error is
 * worth another attempt (model-errors.ts).
 */
export async function modelCallStep(call: ModelCall, writable: WritableStream<ModelCallStreamPart>): Promise<ModelResponse> {
	"use step";
	const { runModelAttempt } = await import("./model-attempt.ts");
	return runModelAttempt(call, writable);
}
modelCallStep.maxRetries = MODEL_CALL_ATTEMPTS - 1;
