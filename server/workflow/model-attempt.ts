import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { isStepCount, jsonSchema, streamText, tool, wrapLanguageModel, type TextStreamPart, type ToolSet } from "ai";
import { FatalError, getStepMetadata, RetryableError } from "workflow";
import { isAuto } from "../../shared/auto-model.ts";
import { answeringModel } from "../auto-router.ts";
import { saveTokenRatio } from "../compaction/store.ts";
import { measuredRatio } from "../compaction/tokens.ts";
import { callCost } from "../telemetry/cost.ts";
import { tracingState } from "../tracing/state.ts";
import { calledToolName } from "./connectors.ts";
import { ModelCallRecord, settleEarlierAttempts, type CallUsage } from "../telemetry/model-calls.ts";
import type { ModelCall, ModelResponse, ModelToolCall } from "./model-call.ts";
import { classifyModelError, FIRST_CHUNK_MS, ModelStalledError, NEXT_CHUNK_MS } from "./model-errors.ts";
import { ChatModel } from "./model.ts";
import { RESET_STEP, storedPart, toolCallOf } from "./stream-parts.ts";

/**
 * One attempt at a reply's model call, inside the model step (model-call.ts). Runs in
 * plain Node, so it may load anything.
 */
export async function runModelAttempt(call: ModelCall, writable: WritableStream<ModelCallStreamPart>): Promise<ModelResponse> {
	const { stepId, attempt } = getStepMetadata();
	const record = new ModelCallRecord(ModelCallRecord.id(call.runId, stepId, attempt), { threadId: call.threadId, user: call.owner, model: call.modelId });
	// This attempt replaces the earlier ones, so none of them stays charged (model-calls.ts).
	if (attempt > 1) await settleEarlierAttempts(call.threadId, call.runId, stepId, record.id);
	return new ModelAttempt(call, attempt, record).run(writable);
}

type Finish = Extract<TextStreamPart<ToolSet>, { type: "finish-step" }>;

class ModelAttempt {
	private started: Promise<void> | undefined;

	constructor(
		private readonly call: ModelCall,
		private readonly attempt: number,
		private readonly record: ModelCallRecord,
	) {}

	async run(writable: WritableStream<ModelCallStreamPart>): Promise<ModelResponse> {
		const writer = writable.getWriter();
		try {
			await writer.write(RESET_STEP);
			const response = await this.stream(writer);
			await this.started;
			return response;
		} catch (error) {
			throw await this.failed(error);
		} finally {
			writer.releaseLock();
		}
	}

	/** Streams the model's output to the page, and returns the response when the model finishes. */
	private async stream(writer: WritableStreamDefaultWriter<ModelCallStreamPart>): Promise<ModelResponse> {
		const watchdog = new Watchdog();
		const result = streamText({
			model: this.model(),
			instructions: this.call.instructions,
			messages: this.call.messages,
			tools: this.tools(),
			stopWhen: isStepCount(1),
			// This step owns retries (model-errors.ts), so the AI SDK makes one request.
			maxRetries: 0,
			abortSignal: watchdog.signal,
			// The call's cost is recorded by this attempt (model-calls.ts). A list of integrations
			// replaces the global one, so the RunRecorder can't record it twice; only the trace's
			// integration (server/tracing/setup.ts) gets the call, as a `chat <model>` span.
			telemetry: traceOnly(),
			// Errors come as stream parts, which this attempt handles.
			onError: () => {},
		});
		let error: unknown;
		let finish: Finish | undefined;
		const toolCalls: ModelToolCall[] = [];
		try {
			for await (const part of result.fullStream) {
				if (part.type === "error") error ??= part.error;
				if (part.type === "abort") error ??= watchdog.signal.reason;
				if (part.type === "finish-step") finish = part;
				if (part.type === "tool-call") toolCalls.push(toolCallOf(part));
				const stored = storedPart(part);
				if (!stored) continue;
				// Only the model's output counts: streamText sends its own start parts at once.
				watchdog.touch();
				await writer.write(stored);
			}
		} finally {
			watchdog.stop();
		}
		if (error !== undefined) throw error;
		if (!finish) throw new ModelStalledError("The model's stream ended without finishing.");
		// Only the assistant message: the SDK adds its own error results for invalid calls, and the loop adds every result.
		const messages = (await result.response).messages.filter((message) => message.role === "assistant");
		await this.started;
		const usage = this.usage(finish, toolCalls);
		await this.record.finish(usage, { stopped: await runStopped(this.call.runId) });
		await this.measureRatio(usage.inputTokens);
		const answeredBy = isAuto(this.call.modelId) ? await answeringModel(finish.response.modelId) : undefined;
		return { messages, toolCalls, finishReason: finish.finishReason, inputTokens: usage.inputTokens, ...(answeredBy && { answeredBy }) };
	}

	/**
	 * Keeps the thread's measured ratio of the provider's tokens to Ponder's estimate,
	 * which compaction decides from (compaction/tokens.ts). Only a finished call measures.
	 */
	private async measureRatio(inputTokens: number) {
		const ratio = this.call.estimated && measuredRatio(inputTokens, this.call.estimated);
		if (!ratio) return;
		await saveTokenRatio(this.call.threadId, this.call.modelId, ratio).catch((error) => console.warn("model-attempt: could not save the token ratio:", error));
	}

	/** The error to throw: another attempt after a wait, or the end of the reply. */
	private async failed(error: unknown) {
		const verdict = classifyModelError(error, this.attempt);
		await this.started?.catch(() => undefined);
		await this.record.fail(verdict.retry ? "retried" : "failed").catch((cause) => console.warn("model-attempt: could not record a failed call:", cause));
		console.warn(`model-attempt: ${this.call.modelId} attempt ${this.attempt} failed (${verdict.retry ? `retry in ${verdict.afterMs} ms` : "no retry"}): ${verdict.reason}`);
		return verdict.retry ? new RetryableError(verdict.reason, { retryAfter: verdict.afterMs }) : new FatalError(verdict.reason);
	}

	/** The model, with a tap on its stream that writes the `runs` row as soon as OpenRouter names the call. */
	private model() {
		const onGeneration = (id: string) => {
			this.started ??= this.record.start(id).catch((error) => console.warn("model-attempt: could not record a started call:", error));
		};
		return wrapLanguageModel({
			model: new ChatModel(this.call.modelId, this.call.threadId),
			middleware: {
				specificationVersion: "v4",
				wrapStream: async ({ doStream }) => {
					const { stream, ...rest } = await doStream();
					const tap = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
						transform(part, controller) {
							if (part.type === "response-metadata" && part.id) onGeneration(part.id);
							controller.enqueue(part);
						},
					});
					return { ...rest, stream: stream.pipeThrough(tap) };
				},
			},
		});
	}

	/** The tools without `execute`, so the model only asks for calls. */
	private tools(): ToolSet {
		return Object.fromEntries(this.call.tools.map((spec) => [spec.name, tool({ description: spec.description, inputSchema: jsonSchema(spec.inputSchema) })]));
	}

	private usage(finish: Finish, toolCalls: ModelToolCall[]): CallUsage {
		return {
			model: finish.response.modelId ?? this.call.modelId,
			inputTokens: finish.usage.inputTokens ?? 0,
			outputTokens: finish.usage.outputTokens ?? 0,
			cachedTokens: finish.usage.inputTokenDetails?.cacheReadTokens ?? 0,
			costUsd: callCost({ providerMetadata: finish.providerMetadata, usage: finish.usage }),
			finishReason: finish.finishReason,
			// The connector's own tool for a connector_call, as /admin shows it.
			toolCalls: toolCalls.map(calledToolName),
		};
	}
}

/** The telemetry of a model call: tracing only, or none when tracing is off. */
function traceOnly() {
	const tracing = tracingState()?.integration;
	return tracing ? { integrations: [tracing], recordInputs: false, recordOutputs: false } : { isEnabled: false };
}

/** Whether Stop cancelled the reply's workflow run. The run's own status, so a newer run in the thread does not matter. */
async function runStopped(runId: string) {
	const { getRun } = await import("workflow/api");
	return (await getRun(runId).status.catch(() => undefined)) === "cancelled";
}

/** Aborts the call when the model sends nothing for too long: first FIRST_CHUNK_MS, then NEXT_CHUNK_MS between chunks. */
class Watchdog {
	private readonly controller = new AbortController();
	private timer: ReturnType<typeof setTimeout> | undefined;
	readonly signal = this.controller.signal;

	constructor() {
		this.arm(FIRST_CHUNK_MS, "The model sent nothing");
	}

	touch() {
		this.arm(NEXT_CHUNK_MS, "The model's stream stopped");
	}

	stop() {
		clearTimeout(this.timer);
	}

	private arm(ms: number, what: string) {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.controller.abort(new ModelStalledError(`${what} for ${ms / 1000} seconds.`)), ms);
	}
}
