/**
 * The `runs` rows of a reply's model calls, which credits are charged from, on a real
 * Postgres (TEST_DATABASE_URL, vitest.config.ts), with a fake OpenRouter for the costs
 * the sweep looks up. Each test uses a thread and run of its own, and the last one
 * deletes them, so the database's other rows are left alone.
 */
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as PonderConfig from "../config.ts";
import * as OpenRouter from "../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import * as Database from "../runtime/Database.ts";
import * as Secrets from "../secrets/Secrets.ts";
import * as ModelCalls from "./ModelCalls.ts";
import * as Runs from "./Runs.ts";

const url = process.env.TEST_DATABASE_URL;
const run = Math.random().toString(36).slice(2, 10);
const threadId = `test-thread-${run}`;
const user = `test-user-${run}`;
const runId = `wrun_${run}`;

/** OpenRouter's generation API: a cost for the generations it knows, 404 for the others. */
const costs: Record<string, { total_cost: number; tokens_prompt: number; tokens_completion: number }> = {
	[`gen-known-${run}`]: { total_cost: 0.004321, tokens_prompt: 1200, tokens_completion: 80 },
};
const asked: string[] = [];
const fakeOpenRouter = HttpClient.make((request, address) =>
	Effect.sync(() => {
		const id = address.searchParams.get("id") ?? "";
		asked.push(`${address.pathname} ${id} ${request.headers.authorization}`);
		const known = costs[id];
		return HttpClientResponse.fromWeb(request, known ? Response.json({ data: known }) : new Response("not yet", { status: 404 }));
	}),
);

const layer = Layer.mergeAll(ModelCalls.layer, Runs.layer).pipe(
	Layer.provide(OpenRouterKey.layer),
	Layer.provide(Layer.mergeAll(OpenRouter.layer, Secrets.layer)),
	Layer.provideMerge(Layer.mergeAll(Database.layer, Layer.succeed(HttpClient.HttpClient, fakeOpenRouter))),
	Layer.provide(PonderConfig.layerFromEnv({ ...(url ? { DATABASE_URL: url } : {}), OPENROUTER_API_KEY: "sk-or-v1-env-key", OPENROUTER_BASE_URL: "http://fake.test/api" })),
);

const usage = (overrides: Partial<ModelCalls.CallUsage> = {}): ModelCalls.CallUsage => ({
	model: "anthropic/claude-haiku-5.5-20261001",
	inputTokens: 1000,
	outputTokens: 50,
	cachedTokens: 900,
	costUsd: 0.000123,
	toolCalls: ["web_search"],
	finishReason: "stop",
	...overrides,
});

const context = { threadId, user, model: "openrouter/auto" };

describe.skipIf(!url)("ModelCalls and Runs", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		type Row = {
			finish_reason: string;
			model: string;
			input_tokens: number;
			output_tokens: number;
			cached_tokens: number;
			cost_usd: string | null;
			tool_calls: unknown;
			generation_id: string | null;
			duration_ms: number;
			cost_tries: number;
			cost_next_at: Date | null;
		};
		const rowOf = (id: string) =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const rows = yield* sql<Row>`
					select finish_reason, model, input_tokens, output_tokens, cached_tokens, cost_usd, tool_calls, generation_id, duration_ms, cost_tries, cost_next_at
					from runs where id = ${id}`;
				return rows[0];
			});

		it.effect("migrates twice without a change", () =>
			Effect.gen(function* () {
				const runs = yield* Runs.Runs;
				yield* runs.migrate;
				yield* runs.migrate;
			}),
		);

		it.effect("writes a call's row when it starts, and its tokens and cost when it finishes", () =>
			Effect.gen(function* () {
				const calls = yield* ModelCalls.ModelCalls;
				const sql = yield* PgClient.PgClient;
				const id = ModelCalls.recordId(runId, "step_1", 1);
				assert.strictEqual(id, `${runId}:step_1:1`);
				const record = yield* calls.record(id, context);
				// Nothing before OpenRouter names the call: a call that never began can't be billed.
				yield* record.fail("failed");
				assert.isUndefined(yield* rowOf(id));

				yield* record.start(`gen-a-${run}`);
				yield* record.start(`gen-a-${run}`);
				assert.deepInclude(yield* rowOf(id), { finish_reason: "started", input_tokens: 0, cost_usd: null, generation_id: `gen-a-${run}` });

				yield* record.finish(usage(), { stopped: false });
				const row = (yield* rowOf(id))!;
				// numeric comes back as a string, with the 6 places of numeric(12, 6).
				assert.deepInclude(row, { finish_reason: "stop", model: "anthropic/claude-haiku-5.5-20261001", input_tokens: 1000, output_tokens: 50, cached_tokens: 900, cost_usd: "0.000123" });
				assert.deepStrictEqual(row.tool_calls, [{ name: "web_search", status: "ok" }]);
				assert.isAtLeast(row.duration_ms, 0);
				const [charged] = yield* sql<{ is_reply: boolean }>`select is_reply from charged_runs where id = ${id}`;
				assert.deepStrictEqual(charged, { is_reply: true });
				// A finished call is not changed again, by a late failure or another finish.
				yield* record.fail("failed");
				yield* record.finish(usage({ costUsd: 9 }), { stopped: false });
				assert.strictEqual((yield* rowOf(id))!.cost_usd, "0.000123");
			}),
		);

		it.effect("charges a call that Stop cut short, and does not count it as a reply", () =>
			Effect.gen(function* () {
				const calls = yield* ModelCalls.ModelCalls;
				const sql = yield* PgClient.PgClient;
				const id = ModelCalls.recordId(runId, "step_2", 1);
				const record = yield* calls.record(id, context);
				yield* record.start(`gen-b-${run}`);
				yield* calls.stop(threadId, runId);
				yield* record.finish(usage({ finishReason: "tool-calls" }), { stopped: false });
				assert.deepInclude(yield* rowOf(id), { finish_reason: "stopped", input_tokens: 1000, cost_usd: "0.000123" });
				assert.deepStrictEqual(yield* sql`select is_reply from charged_runs where id = ${id}`, [{ is_reply: false }]);
				// And when the run itself was cancelled.
				const cancelled = yield* calls.record(ModelCalls.recordId(runId, "step_3", 1), context);
				yield* cancelled.start(`gen-c-${run}`);
				yield* cancelled.finish(usage(), { stopped: true });
				assert.strictEqual((yield* rowOf(cancelled.id))!.finish_reason, "stopped");
			}),
		);

		it.effect("settles the earlier attempts of a call, and the calls a crash cut short", () =>
			Effect.gen(function* () {
				const calls = yield* ModelCalls.ModelCalls;
				const crashed = yield* calls.record(ModelCalls.recordId(runId, "step_4", 1), context);
				yield* crashed.start(`gen-d-${run}`);
				const lost = yield* calls.record(ModelCalls.recordId(runId, "step_4", 2), context);
				yield* lost.start(`gen-e-${run}`);
				yield* lost.finish(usage(), { stopped: false });
				const current = ModelCalls.recordId(runId, "step_4", 3);
				yield* calls.settleEarlierAttempts(threadId, runId, "step_4", current);
				assert.strictEqual((yield* rowOf(crashed.id))!.finish_reason, "interrupted");
				assert.strictEqual((yield* rowOf(lost.id))!.finish_reason, "retried");

				const failing = yield* calls.record(current, context);
				yield* failing.start(`gen-f-${run}`);
				yield* failing.fail("retried");
				assert.strictEqual((yield* rowOf(current))!.finish_reason, "retried");

				const last = yield* calls.record(ModelCalls.recordId(runId, "step_5", 1), context);
				yield* last.start(`gen-g-${run}`);
				yield* calls.settle(threadId, runId);
				assert.strictEqual((yield* rowOf(last.id))!.finish_reason, "interrupted");
			}),
		);

		it.effect("gets the cost of a call cut short from OpenRouter, and asks again later when it has none yet", () =>
			Effect.gen(function* () {
				const calls = yield* ModelCalls.ModelCalls;
				const known = yield* calls.record(ModelCalls.recordId(runId, "step_6", 1), context);
				yield* known.start(`gen-known-${run}`);
				yield* known.fail("failed");
				const unknown = yield* calls.record(ModelCalls.recordId(runId, "step_7", 1), context);
				yield* unknown.start(`gen-unknown-${run}`);
				yield* unknown.fail("failed");

				yield* calls.fillCosts;
				assert.include(asked, `/api/v1/generation gen-known-${run} Bearer sk-or-v1-env-key`);
				assert.deepInclude(yield* rowOf(known.id), { cost_usd: "0.004321", input_tokens: 1200, output_tokens: 80, cost_tries: 1, finish_reason: "failed" });
				const waiting = (yield* rowOf(unknown.id))!;
				assert.strictEqual(waiting.cost_usd, null);
				assert.strictEqual(waiting.cost_tries, 1);
				// 2^0 = 1 minute from now.
				const wait = waiting.cost_next_at!.getTime() - Date.now();
				assert.isTrue(wait > 0 && wait <= 60_000, `${wait}`);

				// Not asked again before its time, and the one with a cost is done.
				asked.length = 0;
				yield* calls.fillCosts;
				assert.isFalse(asked.some((line) => line.includes(run)));
			}),
		);

		it.effect("reports a person's usage: every run, and totals without the uncharged calls and the app's own", () =>
			Effect.gen(function* () {
				const runs = yield* Runs.Runs;
				yield* runs.insert({
					id: `${runId}:title`,
					parentId: null,
					threadId,
					user,
					functionId: Runs.TITLE_FUNCTION_ID,
					model: "z-ai/glm-5.3-flash",
					steps: 1,
					inputTokens: 10,
					outputTokens: 5,
					cachedTokens: 0,
					costUsd: 0.5,
					durationMs: 12,
					toolCalls: [],
					finishReason: "stop",
				});
				const report = yield* runs.usageReport({ user, thread: threadId });
				assert.strictEqual(report.runs.length, 10);
				assert.isTrue(report.runs.every((row) => row.thread_id === threadId && row.created_at instanceof Date));
				const title = report.runs.find((row) => row.id === `${runId}:title`)!;
				assert.strictEqual(title.cost_usd, 0.5);
				// Every run that costs credits: step_1, and step_2 and step_3 that Stop cut short. The calls a crash or an error cut short, and the title (the app's own call), are left out.
				assert.deepStrictEqual(report.totals, { runs: 3, input_tokens: 3000, output_tokens: 150, cached_tokens: 2700, cost_usd: 0.000369 });
				assert.deepStrictEqual(yield* runs.usageReport({ user, thread: "" }), yield* runs.usageReport({ user }));
				assert.deepStrictEqual((yield* runs.usageReport({ user: `nobody-${run}` })).totals, { runs: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_usd: 0 });
			}),
		);

		it.effect("cleans up", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`delete from runs where thread_id = ${threadId}`;
			}),
		);
	});
});
