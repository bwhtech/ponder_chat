import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { isStepCount, jsonSchema, streamText, tool, wrapLanguageModel, type TextStreamPart, type ToolSet } from "ai";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { isSqlError, type SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import { isAuto } from "../../shared/auto-model.ts";
import * as CompactionStore from "../compaction/store.ts";
import { measuredRatio } from "../compaction/tokens.ts";
import * as AutoRouter from "../models/AutoRouter.ts";
import { problem, sqlMessage } from "../runtime/Database.ts";
import type { StepRules } from "../runtime/step.ts";
import { callCost } from "../telemetry/cost.ts";
import * as ModelCalls from "../telemetry/ModelCalls.ts";
import { tracingState } from "../tracing/state.ts";
import { calledToolName } from "./connectors.ts";
import type { ModelCall, ModelResponse, ModelToolCall } from "./model-call.ts";
import { classifyModelError, FIRST_CHUNK_MS, ModelStalledError, NEXT_CHUNK_MS, RESEARCH_FIRST_CHUNK_MS, RESEARCH_NEXT_CHUNK_MS } from "./model-errors.ts";
import * as ChatModels from "./model.ts";
import { CoalescingWriter } from "./coalesce.ts";
import { RESET_STEP, storedPart, toolCallOf } from "./stream-parts.ts";
import * as WorkflowRuns from "./WorkflowRuns.ts";

/**
 * One attempt at a reply's model call, inside the model step (model-call.ts), which runs
 * it with runStep. Runs in plain Node, so it may load anything.
 *
 * The attempt ends with one of two errors, which runStep throws as the Workflow errors
 * that the step threw before (`rules` below): ModelCallRetry, another attempt after
 * `afterMs`, or ModelCallFatal, the end of the reply. Each has the reason as its message
 * (model-errors.ts). A database failure before the call, while its `runs` row is made, is
 * thrown as it is, and Workflow runs the step again. An interruption (the server stops)
 * records nothing, as a crash does: the next attempt settles the row (ModelCalls.settleEarlierAttempts).
 *
 * No span of its own: the AI SDK's `chat <model>` span stays the step's child, as it was.
 */
export class ModelCallRetry extends Schema.TaggedError<ModelCallRetry>()("ModelCallRetry", {
	reason: Schema.String,
	afterMs: Schema.Number,
}) {
	override get message() {
		return this.reason;
	}
}

export class ModelCallFatal extends Schema.TaggedError<ModelCallFatal>()("ModelCallFatal", {
	reason: Schema.String,
}) {
	override get message() {
		return this.reason;
	}
}

/** What the model's stream, the AI SDK or the reply's stream threw, kept as it is for classifyModelError. */
class AttemptBroke extends Schema.TaggedError<AttemptBroke>()("AttemptBroke", {
	cause: Schema.Defect(),
}) {}

/** How the model step's failures reach Workflow (runtime/step.ts). */
export const rules: StepRules<ModelCallRetry | ModelCallFatal | SqlError> = {
	fatal: ["ModelCallFatal"],
	retryable: { ModelCallRetry: (error) => ({ retryAfter: error.afterMs }) },
};

/** The step and the attempt the model step is in (Workflow's getStepMetadata). */
export type StepAttempt = { stepId: string; attempt: number };

type Finish = Extract<TextStreamPart<ToolSet>, { type: "finish-step" }>;

export const run = Effect.fnUntraced(function* (call: ModelCall, writable: WritableStream<ModelCallStreamPart>, step: StepAttempt) {
	const calls = yield* ModelCalls.ModelCalls;
	const id = ModelCalls.recordId(call.runId, step.stepId, step.attempt);
	const record = yield* calls.record(id, { threadId: call.threadId, user: call.owner, model: call.modelId });
	// This attempt replaces the earlier ones, so none of them stays charged (telemetry/ModelCalls.ts).
	if (step.attempt > 1) yield* calls.settleEarlierAttempts(call.threadId, call.runId, step.stepId, record.id);
	return yield* attemptCall(call, writable, step.attempt, record).pipe(Effect.scoped);
});

const attemptCall = Effect.fnUntraced(function* (call: ModelCall, writable: WritableStream<ModelCallStreamPart>, attempt: number, record: ModelCalls.ModelCallRecord) {
	// The `runs` row is written as soon as OpenRouter names the call, beside the stream, so
	// the stream does not wait for it. `recorded` waits for it, once a name came.
	const generation = yield* Deferred.make<string>();
	const started = yield* Deferred.await(generation).pipe(
		Effect.flatMap(record.start),
		Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logWarning("model-attempt: could not record a started call:", problem(Cause.squash(cause))))),
		Effect.forkScoped,
	);
	const recorded = Effect.gen(function* () {
		if (yield* Deferred.isDone(generation)) yield* Fiber.join(started);
	});
	const writer = yield* Effect.acquireRelease(
		Effect.sync(() => writable.getWriter()),
		(writer) => Effect.sync(() => writer.releaseLock()),
	);

	/** The error to fail with: another attempt after a wait, or the end of the reply. */
	const failed = Effect.fnUntraced(function* (error: unknown) {
		// A database failure says what Postgres said, as postgres.js's error did.
		const cause = error instanceof AttemptBroke ? error.cause : isSqlError(error) ? new Error(sqlMessage(error)) : error;
		const verdict = classifyModelError(cause, attempt);
		yield* recorded;
		yield* record
			.fail(verdict.retry ? "retried" : "failed")
			.pipe(Effect.catchTags({ SqlError: (failure) => Effect.logWarning("model-attempt: could not record a failed call:", sqlMessage(failure)) }));
		yield* Effect.logWarning(`model-attempt: ${call.modelId} attempt ${attempt} failed (${verdict.retry ? `retry in ${verdict.afterMs} ms` : "no retry"}): ${verdict.reason}`);
		return yield* verdict.retry ? new ModelCallRetry({ reason: verdict.reason, afterMs: verdict.afterMs }) : new ModelCallFatal({ reason: verdict.reason });
	});

	return yield* Effect.gen(function* () {
		yield* write(writer, RESET_STEP);
		const { finish, toolCalls, messages } = yield* modelStream(call, writer, generation);
		yield* recorded;
		const usage = usageOf(call, finish, toolCalls);
		const stopped = yield* runStopped(call.runId);
		yield* record.finish(usage, { stopped });
		yield* measureRatio(call, usage.inputTokens);
		const answeredBy = isAuto(call.modelId) ? Option.getOrUndefined(yield* AutoRouter.AutoRouter.use((router) => router.answeringModel(finish.response.modelId))) : undefined;
		return { messages, toolCalls, finishReason: finish.finishReason, inputTokens: usage.inputTokens, ...(answeredBy && { answeredBy }) } satisfies ModelResponse;
	}).pipe(Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : failed(Cause.squash(cause)))));
});

/**
 * Streams the model's output to the page, and gives what the model finished with. The
 * request is aborted when this ends, however it ends: a stall, a failure, an interruption.
 */
const modelStream = Effect.fnUntraced(
	function* (call: ModelCall, writer: WritableStreamDefaultWriter<ModelCallStreamPart>, generation: Deferred.Deferred<string>) {
		// The first wait counts from here, before the key and the settings are read, as the watchdog's did.
		const since = yield* Clock.currentTimeMillis;
		const model = yield* ChatModels.ChatModels.use((models) => models.make(call.modelId, call.threadId));
		// The request's own scope, closed (which aborts the request) when the attempt ends,
		// and at once on a stall: the stream can only stop once the request is aborted.
		const request = yield* Scope.make();
		yield* Effect.addFinalizer(() => Scope.close(request, Exit.void));
		const signal = yield* Scope.provide(request)(Effect.abortSignal);
		const result = streamText({
			model: withGenerationTap(model, generation),
			instructions: call.instructions,
			messages: call.messages,
			tools: toolsOf(call),
			stopWhen: isStepCount(1),
			// This step owns retries (model-errors.ts), so the AI SDK makes one request.
			maxRetries: 0,
			abortSignal: signal,
			// The call's cost is recorded by this attempt (telemetry/ModelCalls.ts). A list of integrations
			// replaces the global one, so the RunRecorder can't record it twice; only the trace's
			// integration (server/tracing/setup.ts) gets the call, as a `chat <model>` span.
			telemetry: traceOnly(),
			// Errors come as stream parts, which this attempt handles.
			onError: () => {},
		});
		const seen: { error?: unknown; finish?: Finish } = {};
		// The model's small pieces are joined before they are written (coalesce.ts).
		const out = new CoalescingWriter(writer);
		const toolCalls: ModelToolCall[] = [];
		const stall = stallDeadline(since, call.research ? { first: RESEARCH_FIRST_CHUNK_MS, next: RESEARCH_NEXT_CHUNK_MS } : { first: FIRST_CHUNK_MS, next: NEXT_CHUNK_MS });
		// Per part: no span for each one.
		const take = Effect.fnUntraced(function* (part: TextStreamPart<ToolSet>) {
			if (part.type === "error") seen.error ??= part.error;
			if (part.type === "abort") seen.error ??= signal.reason;
			if (part.type === "finish-step") seen.finish = part;
			if (part.type === "tool-call") toolCalls.push(toolCallOf(part));
			const stored = storedPart(part);
			if (!stored) return;
			// Only the model's output counts: streamText sends its own start parts at once.
			stall.moved(yield* Clock.currentTimeMillis);
			yield* Effect.tryPromise({ try: () => out.write(stored), catch: (cause) => new AttemptBroke({ cause }) });
		});
		// The deadline is watched on its own, so a write that waits (the durable stream)
		// can't hold it off, as the old watchdog's timer could not be held off.
		yield* Effect.raceFirst(
			Stream.fromAsyncIterable(result.fullStream, (cause) => new AttemptBroke({ cause })).pipe(
				Stream.runForEach(take),
				// What waited is written before the step returns, still inside the stall's deadline;
				// a write that failed fails the attempt.
				Effect.andThen(Effect.tryPromise({ try: () => out.flush(), catch: (cause) => new AttemptBroke({ cause }) })),
			),
			stall.watch.pipe(Effect.tapError(() => Scope.close(request, Exit.void))),
		).pipe(
			// On a failure, what waited is sent on without waiting for it: a write that hangs must not hold the attempt.
			Effect.ensuring(Effect.sync(() => void out.flush().catch(() => undefined))),
		);
		const { error, finish } = seen;
		if (error !== undefined) return yield* new AttemptBroke({ cause: error });
		if (!finish) return yield* Effect.fail(new ModelStalledError("The model's stream ended without finishing."));
		// Only the assistant message: the SDK adds its own error results for invalid calls, and the loop adds every result.
		const response = yield* Effect.tryPromise({ try: () => result.response, catch: (cause) => new AttemptBroke({ cause }) });
		return { finish, toolCalls, messages: response.messages.filter((message) => message.role === "assistant") };
	},
	Effect.scoped,
);

/**
 * The stall timeout on the model's stream: `watch` fails with ModelStalledError when the
 * model sends nothing for too long, first `limits.first` from `since`, then `limits.next`
 * after each part of the model's output (`moved`). It looks again at the deadline, or
 * after `limits.next` when that comes first: a part may move the deadline while it sleeps,
 * and a moved deadline is never further than `limits.next` from the time it moved.
 * Deep research has longer limits (model-errors.ts).
 */
function stallDeadline(since: number, limits: { first: number; next: number }) {
	let deadline = since + limits.first;
	let stalled = () => new ModelStalledError(`The model sent nothing for ${limits.first / 1000} seconds.`);
	const watch: Effect.Effect<never, ModelStalledError> = Effect.gen(function* () {
		while (true) {
			const now = yield* Clock.currentTimeMillis;
			if (now >= deadline) return yield* Effect.fail(stalled());
			yield* Effect.sleep(Duration.millis(Math.min(deadline - now, limits.next)));
		}
	});
	return {
		watch,
		moved(at: number) {
			deadline = at + limits.next;
			stalled = () => new ModelStalledError(`The model's stream stopped for ${limits.next / 1000} seconds.`);
		},
	};
}

/** Writes a part to the reply's stream. Per part: no span. */
const write = (writer: WritableStreamDefaultWriter<ModelCallStreamPart>, part: ModelCallStreamPart) =>
	Effect.tryPromise({ try: () => writer.write(part), catch: (cause) => new AttemptBroke({ cause }) });

/**
 * Keeps the thread's measured ratio of the provider's tokens to Ponder's estimate,
 * which compaction decides from (compaction/tokens.ts). Only a finished call measures.
 */
const measureRatio = Effect.fnUntraced(function* (call: ModelCall, inputTokens: number) {
	const ratio = call.estimated && measuredRatio(inputTokens, call.estimated);
	if (!ratio) return;
	yield* CompactionStore.CompactionStore.use((store) => store.saveTokenRatio(call.threadId, call.modelId, ratio)).pipe(
		Effect.catchTags({ SqlError: (error) => Effect.logWarning("model-attempt: could not save the token ratio:", sqlMessage(error)) }),
	);
});

/**
 * Whether Stop cancelled the reply's workflow run. The run's own status, so a newer run in
 * the thread does not matter. A status that can't be read counts as not stopped.
 */
const runStopped = (runId: string) =>
	WorkflowRuns.WorkflowRuns.use((runs) => runs.status(runId)).pipe(
		Effect.exit,
		Effect.map((exit) => Exit.isSuccess(exit) && exit.value === "cancelled"),
	);

/** The model, with a tap on its stream that names the call as soon as OpenRouter does: the `runs` row is written then. */
function withGenerationTap(model: LanguageModelV4, generation: Deferred.Deferred<string>) {
	return wrapLanguageModel({
		model,
		middleware: {
			specificationVersion: "v4",
			wrapStream: async ({ doStream }) => {
				const { stream, ...rest } = await doStream();
				const tap = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
					transform(part, controller) {
						// The first name only; completing the deferred again does nothing.
						if (part.type === "response-metadata" && part.id) Deferred.doneUnsafe(generation, Exit.succeed(part.id));
						controller.enqueue(part);
					},
				});
				return { ...rest, stream: stream.pipeThrough(tap) };
			},
		},
	});
}

/** The tools without `execute`, so the model only asks for calls. */
function toolsOf(call: ModelCall): ToolSet {
	return Object.fromEntries(call.tools.map((spec) => [spec.name, tool({ description: spec.description, inputSchema: jsonSchema(spec.inputSchema) })]));
}

function usageOf(call: ModelCall, finish: Finish, toolCalls: ModelToolCall[]): ModelCalls.CallUsage {
	return {
		model: finish.response.modelId ?? call.modelId,
		inputTokens: finish.usage.inputTokens ?? 0,
		outputTokens: finish.usage.outputTokens ?? 0,
		cachedTokens: finish.usage.inputTokenDetails?.cacheReadTokens ?? 0,
		costUsd: callCost({ providerMetadata: finish.providerMetadata, usage: finish.usage }),
		finishReason: finish.finishReason,
		// The connector's own tool for a connector_call, as /admin shows it.
		toolCalls: toolCalls.map(calledToolName),
	};
}

/** The telemetry of a model call: tracing only, or none when tracing is off. */
function traceOnly() {
	const tracing = tracingState()?.integration;
	return tracing ? { integrations: [tracing], recordInputs: false, recordOutputs: false } : { isEnabled: false };
}
