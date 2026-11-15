/**
 * One attempt at a reply's model call (model-attempt.ts): the stall timeout on the model's
 * stream, with TestClock, and the `runs` row on success, failure, Stop and interruption, on
 * a real Postgres (TEST_DATABASE_URL, vitest.config.ts). Only the outside systems are fakes:
 * the model (OpenRouter) and Workflow's runtime. The stall tests need no database: a call
 * that OpenRouter never names writes no row.
 */
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { FatalError, RetryableError } from "workflow";
import * as CompactionStore from "../compaction/store.ts";
import * as PonderConfig from "../config.ts";
import * as AutoRouter from "../models/AutoRouter.ts";
import * as Models from "../models/Models.ts";
import * as OpenRouter from "../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import * as Database from "../runtime/Database.ts";
import { runStep } from "../runtime/step.ts";
import * as Secrets from "../secrets/Secrets.ts";
import * as Settings from "../settings/Settings.ts";
import * as ModelCalls from "../telemetry/ModelCalls.ts";
import * as Runs from "../telemetry/Runs.ts";
import type { ModelCall } from "./model-call.ts";
import * as ModelAttempt from "./model-attempt.ts";
import { FIRST_CHUNK_MS, NEXT_CHUNK_MS } from "./model-errors.ts";
import * as ChatModels from "./model.ts";
import * as WorkflowRuns from "./WorkflowRuns.ts";

const url = process.env.TEST_DATABASE_URL;
const tag = Math.random().toString(36).slice(2, 10);
const threadId = `test-attempt-${tag}`;

const call = (runId: string): ModelCall => ({
	runId,
	threadId,
	owner: `test-user-${tag}`,
	modelId: "test/model",
	instructions: "Answer.",
	messages: [{ role: "user", content: "Hello" }],
	tools: [],
});

/** The model's stream, which the test writes to, and what the attempt asked of the model. */
function fakeModel() {
	let controller!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
	const stream = new ReadableStream<LanguageModelV4StreamPart>({ start: (c) => void (controller = c) });
	const called = Deferred.makeUnsafe<LanguageModelV4CallOptions>();
	const model = new MockLanguageModelV4({
		provider: "openrouter",
		modelId: "test/model",
		doStream: async (options) => {
			Deferred.doneUnsafe(called, Exit.succeed(options));
			return { stream };
		},
	});
	return {
		model,
		called,
		send: (...parts: LanguageModelV4StreamPart[]) => parts.forEach((part) => controller.enqueue(part)),
		end: () => controller.close(),
	};
}

/** The reply's stream: what the attempt wrote, and a signal when it wrote a part of `type`. */
function fakeWritable(type: string) {
	const written: ModelCallStreamPart[] = [];
	const wrote = Deferred.makeUnsafe<void>();
	const writable = new WritableStream<ModelCallStreamPart>({
		write: (part) => {
			written.push(part);
			if (part.type === type) Deferred.doneUnsafe(wrote, Exit.void);
		},
	});
	return { writable, written, wrote };
}

const usage = { inputTokens: { total: 1200, noCache: 200, cacheRead: 1000, cacheWrite: undefined }, outputTokens: { total: 40, text: 40, reasoning: undefined } };
const answer = (generationId: string): LanguageModelV4StreamPart[] => [
	{ type: "stream-start", warnings: [] },
	{ type: "response-metadata", id: generationId, modelId: "test/model-2026" },
	{ type: "text-start", id: "t" },
	{ type: "text-delta", id: "t", delta: "Hi there." },
	{ type: "text-end", id: "t" },
	{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage, providerMetadata: { openrouter: { usage: { cost: 0.00042 } } } },
];

/** The services of an attempt, with the fake model, and Workflow saying the run has `status`. */
const layerWith = (model: MockLanguageModelV4, status: WorkflowRuns.RunStatus = "running") =>
	Layer.mergeAll(
		Layer.succeed(ChatModels.ChatModels, ChatModels.ChatModels.of({ make: () => Effect.succeed(model) })),
		Layer.succeed(
			WorkflowRuns.WorkflowRuns,
			WorkflowRuns.WorkflowRuns.of({
				start: () => Effect.die("not in this test"),
				status: () => Effect.succeed(status),
				cancel: () => Effect.void,
				readable: () => Effect.die("not in this test"),
				endStream: () => Effect.void,
			}),
		),
		Layer.mergeAll(ModelCalls.layer, Runs.layer, AutoRouter.layer, CompactionStore.layer).pipe(
			Layer.provide(Layer.mergeAll(Models.layer, OpenRouterKey.layer, Settings.layer)),
			Layer.provide(Layer.mergeAll(OpenRouter.layer, Secrets.layer)),
			Layer.provideMerge(Layer.mergeAll(Database.layer, Layer.succeed(HttpClient.HttpClient, HttpClient.make((request) => Effect.die(`no request in this test: ${request.url}`))))),
			Layer.provide(PonderConfig.layerFromEnv({ DATABASE_URL: url ?? "postgres://ponder@127.0.0.1:9/none", OPENROUTER_API_KEY: "sk-or-v1-test", OPENROUTER_BASE_URL: "http://fake.test/api" })),
		),
	);

describe("a model call's stall timeout", () => {
	it.effect("fails a call whose model sends nothing for FIRST_CHUNK_MS, and aborts its request", () =>
		Effect.gen(function* () {
			const fake = fakeModel();
			const { writable, written } = fakeWritable("none");
			const attempt = yield* ModelAttempt.run(call("wrun_stall_first"), writable, { stepId: "step_1", attempt: 1 }).pipe(Effect.provide(layerWith(fake.model)), Effect.flip, Effect.forkChild);
			const options = yield* Deferred.await(fake.called);
			yield* TestClock.adjust(Duration.millis(FIRST_CHUNK_MS - 1));
			assert.isUndefined(attempt.pollUnsafe(), "the attempt stalled before its time");
			yield* TestClock.adjust(Duration.millis(1));
			const error = yield* Fiber.join(attempt);
			assert.instanceOf(error, ModelAttempt.ModelCallRetry);
			assert.strictEqual(error.message, "The model sent nothing for 600 seconds.");
			assert.isTrue(options.abortSignal?.aborted, "the request was not aborted");
			// Only the reset: streamText's own start parts are not the model's output.
			assert.deepStrictEqual(written, [{ type: "reset-step" }]);
		}),
	);

	it.effect("waits NEXT_CHUNK_MS between the model's parts, from the last one", () =>
		Effect.gen(function* () {
			const fake = fakeModel();
			const { writable, written, wrote } = fakeWritable("text-delta");
			const attempt = yield* ModelAttempt.run(call("wrun_stall_next"), writable, { stepId: "step_1", attempt: 1 }).pipe(Effect.provide(layerWith(fake.model)), Effect.flip, Effect.forkChild);
			yield* Deferred.await(fake.called);
			// Well past the first wait, but the model answers in time.
			yield* TestClock.adjust(Duration.millis(FIRST_CHUNK_MS - 1));
			fake.send({ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Hel" });
			yield* Deferred.await(wrote);
			yield* TestClock.adjust(Duration.millis(NEXT_CHUNK_MS - 1));
			assert.isUndefined(attempt.pollUnsafe(), "the attempt stalled before its time");
			yield* TestClock.adjust(Duration.millis(1));
			const error = yield* Fiber.join(attempt);
			assert.instanceOf(error, ModelAttempt.ModelCallRetry);
			assert.strictEqual(error.message, "The model's stream stopped for 120 seconds.");
			assert.deepStrictEqual(
				written.map((part) => part.type),
				["reset-step", "text-start", "text-delta"],
			);
		}),
	);

});

// The last attempt settles the earlier ones first (ModelCalls.settleEarlierAttempts), which needs the database.
describe.skipIf(!url)("a last attempt's stall", () => {
	it.effect("ends the reply", () =>
		Effect.gen(function* () {
			const fake = fakeModel();
			const { writable } = fakeWritable("none");
			const attempt = yield* ModelAttempt.run(call(`wrun_stall_last_${tag}`), writable, { stepId: "step_1", attempt: 3 }).pipe(Effect.provide(layerWith(fake.model)), Effect.flip, Effect.forkChild);
			yield* Deferred.await(fake.called);
			yield* TestClock.adjust(Duration.millis(FIRST_CHUNK_MS));
			const error = yield* Fiber.join(attempt);
			assert.instanceOf(error, ModelAttempt.ModelCallFatal);
			assert.strictEqual(error.message, "The model sent nothing for 600 seconds.");
		}),
	);
});

describe("how a failed attempt reaches Workflow", () => {
	it("throws a RetryableError with the wait, or a FatalError, with the reason as the message", async () => {
		const before = Date.now();
		const retry = await runStep(Effect.fail(new ModelAttempt.ModelCallRetry({ reason: "Provider returned error", afterMs: 8_500 })), ModelAttempt.rules).catch((error: unknown) => error);
		const after = Date.now();
		assert.isTrue(RetryableError.is(retry));
		assert.strictEqual((retry as RetryableError).message, "Provider returned error");
		// RetryableError keeps the time to run again: now plus the wait.
		const at = (retry as RetryableError).retryAfter.getTime();
		assert.isTrue(at >= before + 8_500 && at <= after + 8_500, `${at - before}`);
		const fatal = await runStep(Effect.fail(new ModelAttempt.ModelCallFatal({ reason: "No endpoints found" })), ModelAttempt.rules).catch((error: unknown) => error);
		assert.isTrue(FatalError.is(fatal));
		assert.strictEqual((fatal as FatalError).message, "No endpoints found");
	});
});

type Row = { finish_reason: string; model: string; input_tokens: number; output_tokens: number; cached_tokens: number; cost_usd: string | null; generation_id: string | null };
const rowOf = (id: string) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const rows = yield* sql<Row>`select finish_reason, model, input_tokens, output_tokens, cached_tokens, cost_usd, generation_id from runs where id = ${id}`;
		return Option.fromUndefinedOr(rows[0]);
	});

describe.skipIf(!url)("a model call's `runs` row", () => {
	const runAttempt = (runId: string, fake: ReturnType<typeof fakeModel>, { attempt = 1, status = "running" as WorkflowRuns.RunStatus } = {}) => {
		const { writable } = fakeWritable("none");
		return ModelAttempt.run(call(runId), writable, { stepId: "step_1", attempt }).pipe(Effect.provide(layerWith(fake.model, status)));
	};
	const database = layerWith(fakeModel().model);
	const setup = Runs.Runs.use((runs) => runs.migrate).pipe(Effect.provide(database));
	afterAll(() =>
		Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`delete from runs where thread_id = ${threadId}`;
			}).pipe(Effect.provide(database)),
		),
	);

	it.live("records a finished call with its tokens and cost, charged", () =>
		Effect.gen(function* () {
			yield* setup;
			const fake = fakeModel();
			fake.send(...answer(`gen-ok-${tag}`));
			fake.end();
			const response = yield* runAttempt(`wrun_ok_${tag}`, fake);
			assert.strictEqual(response.finishReason, "stop");
			assert.strictEqual(response.inputTokens, 1200);
			assert.deepStrictEqual(
				response.messages.map((message) => message.role),
				["assistant"],
			);
			const row = yield* rowOf(`wrun_ok_${tag}:step_1:1`).pipe(Effect.provide(database));
			assert.deepStrictEqual(Option.getOrUndefined(row), {
				finish_reason: "stop",
				model: "test/model-2026",
				input_tokens: 1200,
				output_tokens: 40,
				cached_tokens: 1000,
				cost_usd: "0.000420",
				generation_id: `gen-ok-${tag}`,
			});
		}),
	);

	it.live("finishes a call whose stream ends without a finish part as the SDK closes it: \"other\"", () =>
		Effect.gen(function* () {
			const fake = fakeModel();
			fake.send({ type: "stream-start", warnings: [] }, { type: "response-metadata", id: `gen-end-${tag}` }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Hel" });
			fake.end();
			const response = yield* runAttempt(`wrun_end_${tag}`, fake);
			assert.strictEqual(response.finishReason, "other");
			assert.strictEqual(Option.getOrThrow(yield* rowOf(`wrun_end_${tag}:step_1:1`).pipe(Effect.provide(database))).finish_reason, "other");
		}),
	);

	it.live("keeps the cost of a call that Stop cut short, uncharged", () =>
		Effect.gen(function* () {
			const fake = fakeModel();
			fake.send(...answer(`gen-stop-${tag}`));
			fake.end();
			yield* runAttempt(`wrun_stop_${tag}`, fake, { status: "cancelled" });
			const row = Option.getOrThrow(yield* rowOf(`wrun_stop_${tag}:step_1:1`).pipe(Effect.provide(database)));
			assert.strictEqual(row.finish_reason, "stopped");
			assert.strictEqual(row.cost_usd, "0.000420");
		}),
	);

	it.live("marks a failed call retried, or failed on the last attempt, uncharged", () =>
		Effect.gen(function* () {
			const failing = (generationId: string) => {
				const fake = fakeModel();
				fake.send(
					{ type: "stream-start", warnings: [] },
					{ type: "response-metadata", id: generationId },
					{ type: "error", error: new APICallError({ message: "Upstream error", url: "http://fake.test", requestBodyValues: {}, statusCode: 502 }) },
				);
				fake.end();
				return fake;
			};
			const retried = yield* Effect.flip(runAttempt(`wrun_fail_${tag}`, failing(`gen-retry-${tag}`)));
			assert.instanceOf(retried, ModelAttempt.ModelCallRetry);
			assert.strictEqual(retried.message, "Upstream error");
			assert.strictEqual(Option.getOrThrow(yield* rowOf(`wrun_fail_${tag}:step_1:1`).pipe(Effect.provide(database))).finish_reason, "retried");

			const last = yield* Effect.flip(runAttempt(`wrun_fail_${tag}`, failing(`gen-last-${tag}`), { attempt: 3 }));
			assert.instanceOf(last, ModelAttempt.ModelCallFatal);
			assert.strictEqual(Option.getOrThrow(yield* rowOf(`wrun_fail_${tag}:step_1:3`).pipe(Effect.provide(database))).finish_reason, "failed");
		}),
	);

	it.live("records nothing as failed when it is interrupted, releases the stream and aborts the request", () =>
		Effect.gen(function* () {
			const fake = fakeModel();
			const { writable, wrote } = fakeWritable("text-delta");
			const attempt = yield* ModelAttempt.run(call(`wrun_cut_${tag}`), writable, { stepId: "step_1", attempt: 1 }).pipe(Effect.provide(layerWith(fake.model)), Effect.forkChild);
			const options = yield* Deferred.await(fake.called);
			fake.send({ type: "stream-start", warnings: [] }, { type: "response-metadata", id: `gen-cut-${tag}` }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Hel" });
			yield* Deferred.await(wrote);
			yield* Fiber.interrupt(attempt);
			assert.isTrue(options.abortSignal?.aborted, "the request was not aborted");
			// The lock on the reply's stream is released: the next attempt can write.
			writable.getWriter().releaseLock();
			// A crash leaves the row "started" too: the next attempt settles it (ModelCalls.settleEarlierAttempts).
			const row = yield* rowOf(`wrun_cut_${tag}:step_1:1`).pipe(Effect.provide(database));
			assert.isTrue(Option.isNone(row) || row.value.finish_reason === "started", JSON.stringify(row));
		}),
	);
});
