import * as PgClient from "@effect/sql-pg/PgClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as OpenRouter from "../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import { sqlMessage } from "../runtime/Database.ts";
import { requestProblem } from "../runtime/Http.ts";
import type { UNCHARGED_CALLS } from "./Runs.ts";

/**
 * The `runs` row of each attempt at a reply's model call (workflow/model-attempt.ts).
 * Credits are charged from these rows (Runs.ts, `charged_runs`).
 *
 * The row is written when OpenRouter's first chunk names the call (its generation id),
 * so a call that a crash cuts short is still in `runs`. When the attempt ends, the row
 * gets its tokens and cost. An attempt that failed, or that a crash or Stop cut short,
 * costs no credits. A stream cut short does not report its cost, so the sweep gets it
 * from OpenRouter's generation API later (fillCosts), off the reply's path.
 *
 * The row id is the workflow run, the step and the attempt, so an attempt that runs
 * again never writes a row twice.
 */
type Uncharged = (typeof UNCHARGED_CALLS)[number];
export type CallUsage = {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
	costUsd: number | null;
	toolCalls: string[];
	finishReason: string;
};

/** The most rows one sweep looks up, how long it keeps asking, and the longest wait between two asks of one row. */
const COST_LOOKUPS_PER_SWEEP = 50;
const COST_LOOKUP_DAYS = 1;
const MAX_COST_WAIT_MINUTES = 180;

/** The id of an attempt's row: the workflow run, the step and the attempt. */
export const recordId = (runId: string, stepId: string, attempt: number) => `${runId}:${stepId}:${attempt}`;

/** One attempt's row, from its start (ModelCalls.record). */
export type ModelCallRecord = {
	readonly id: string;
	/** The call has begun on OpenRouter, and may be billed from now on. */
	readonly start: (generationId: string) => Effect.Effect<void, SqlError>;
	/**
	 * The call finished: its tokens and cost. A call that Stop cut short keeps them but
	 * stays uncharged ("stopped"): Stop marked its row (ModelCalls.stop), or its run is
	 * cancelled (`stopped`).
	 */
	readonly finish: (usage: CallUsage, options: { stopped: boolean }) => Effect.Effect<void, SqlError>;
	/** The attempt failed. Only a call that OpenRouter began (start) can be billed, so only it has a row. */
	readonly fail: (finishReason: Extract<Uncharged, "retried" | "failed">) => Effect.Effect<void, SqlError>;
};

/** What OpenRouter billed for one generation. */
type GenerationCost = { usd: number; inputTokens: number; outputTokens: number };

// OpenRouter's answer, of which only these fields are read, when they are numbers.
const GenerationAnswer = Schema.Struct({
	data: Schema.optional(
		Schema.NullOr(Schema.Struct({ total_cost: Schema.optional(Schema.Unknown), tokens_prompt: Schema.optional(Schema.Unknown), tokens_completion: Schema.optional(Schema.Unknown) })),
	),
});
const CostRow = Schema.Struct({ id: Schema.String, generation_id: Schema.String });

export class ModelCalls extends Context.Service<
	ModelCalls,
	{
		/** The row of one attempt, for a call that starts now. Nothing is written until `start`. */
		readonly record: (id: string, context: { threadId: string; user: string; model: string }) => Effect.Effect<ModelCallRecord>;
		/**
		 * Before an attempt that is not the first: the earlier attempts of the same model call.
		 * One cut by a crash still says "started", and becomes "interrupted". One that finished,
		 * but whose result the step lost because the server stopped before it saved it, becomes
		 * "retried": this attempt replaces it, so only this one may be charged.
		 */
		readonly settleEarlierAttempts: (threadId: string, runId: string, stepId: string, current: string) => Effect.Effect<void, SqlError>;
		/**
		 * The run's model calls that a crash cut short on their last attempt: nothing ran again
		 * to settle them. Called when the run saves its reply.
		 */
		readonly settle: (threadId: string, runId: string) => Effect.Effect<void, SqlError>;
		/** After Stop: the run's calls in flight are uncharged, even when they finish later. */
		readonly stop: (threadId: string, runId: string) => Effect.Effect<void, SqlError>;
		/**
		 * Gets the cost of model calls that ended without it, from OpenRouter's generation API.
		 * Run by the sweep (workflow/sweep.ts). OpenRouter can take a few seconds to have a
		 * generation's cost, so a call it can't tell about yet is asked again later: 1 minute
		 * later, then 2, 4 and so on, up to MAX_COST_WAIT_MINUTES apart, for COST_LOOKUP_DAYS.
		 * The rows whose turn came first go first, so a generation that OpenRouter never reports
		 * waits longer and longer instead of keeping the others waiting.
		 */
		readonly fillCosts: Effect.Effect<void, SqlError>;
	}
>()("ponder/telemetry/ModelCalls") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const client = yield* HttpClient.HttpClient;
	const openRouter = yield* OpenRouter.OpenRouter;
	const openRouterKey = yield* OpenRouterKey.OpenRouterKey;

	const record = Effect.fn("ModelCalls.record")(function* (id: string, context: { threadId: string; user: string; model: string }) {
		const startedAt = yield* Clock.currentTimeMillis;
		const generation = yield* Ref.make(Option.none<string>());
		const elapsed = Effect.map(Clock.currentTimeMillis, (now) => now - startedAt);
		const { threadId, user } = context;

		const start = Effect.fn("ModelCalls.start")(function* (generationId: string) {
			yield* Ref.set(generation, Option.some(generationId));
			yield* sql`
				insert into runs (id, parent_id, thread_id, "user", function_id, model, steps, input_tokens, output_tokens,
					cached_tokens, cost_usd, duration_ms, tool_calls, finish_reason, generation_id)
				values (${id}, null, ${threadId}, ${user}, 'chat', ${context.model}, 1, 0, 0, 0, null, 0, '[]', 'started', ${generationId})
				on conflict (id) do nothing`;
		});

		const finish = Effect.fn("ModelCalls.finish")(function* (usage: CallUsage, { stopped }: { stopped: boolean }) {
			const finishReason = stopped ? ("stopped" satisfies Uncharged) : usage.finishReason;
			const toolCalls = sql.json(usage.toolCalls.map((name) => ({ name, status: "ok" })));
			const generationId = Option.getOrNull(yield* Ref.get(generation));
			const durationMs = yield* elapsed;
			yield* sql`
				insert into runs (id, parent_id, thread_id, "user", function_id, model, steps, input_tokens, output_tokens,
					cached_tokens, cost_usd, duration_ms, tool_calls, finish_reason, generation_id)
				values (${id}, null, ${threadId}, ${user}, 'chat', ${usage.model}, 1, ${usage.inputTokens}, ${usage.outputTokens},
					${usage.cachedTokens}, ${usage.costUsd}, ${durationMs}, ${toolCalls}, ${finishReason}, ${generationId})
				on conflict (id) do update set model = excluded.model, input_tokens = excluded.input_tokens,
					output_tokens = excluded.output_tokens, cached_tokens = excluded.cached_tokens, cost_usd = excluded.cost_usd,
					duration_ms = excluded.duration_ms, tool_calls = excluded.tool_calls,
					finish_reason = case when runs.finish_reason = 'stopped' then 'stopped' else excluded.finish_reason end
				where runs.finish_reason in ('started', 'stopped')`;
		});

		const fail = Effect.fn("ModelCalls.fail")(function* (finishReason: Extract<Uncharged, "retried" | "failed">) {
			if (Option.isNone(yield* Ref.get(generation))) return;
			const durationMs = yield* elapsed;
			yield* sql`
				update runs set duration_ms = ${durationMs},
					finish_reason = case when finish_reason = 'stopped' then 'stopped' else ${finishReason} end
				where id = ${id} and finish_reason in ('started', 'stopped')`;
		});

		return { id, start, finish, fail } satisfies ModelCallRecord;
	});

	const settleEarlierAttempts = Effect.fn("ModelCalls.settleEarlierAttempts")(function* (threadId: string, runId: string, stepId: string, current: string) {
		yield* sql`
			update runs set finish_reason = case when finish_reason = 'started' then 'interrupted' else 'retried' end
			where thread_id = ${threadId} and starts_with(id, ${`${runId}:${stepId}:`}) and id <> ${current}
				and finish_reason not in ('interrupted', 'retried', 'failed', 'stopped')`;
	});

	const settle = Effect.fn("ModelCalls.settle")(function* (threadId: string, runId: string) {
		yield* sql`
			update runs set finish_reason = 'interrupted'
			where thread_id = ${threadId} and starts_with(id, ${`${runId}:`}) and finish_reason = 'started'`;
	});

	const stop = Effect.fn("ModelCalls.stop")(function* (threadId: string, runId: string) {
		yield* sql`
			update runs set finish_reason = 'stopped'
			where thread_id = ${threadId} and starts_with(id, ${`${runId}:`}) and finish_reason = 'started'`;
	});

	/** OpenRouter's answer for one generation. None while it does not have the cost yet. */
	const askGeneration = (generationId: string, key: string) =>
		Effect.gen(function* () {
			const response = yield* client.get(openRouter.url(`v1/generation?id=${encodeURIComponent(generationId)}`), { headers: { Authorization: `Bearer ${key}` } });
			// 404: OpenRouter does not have the generation's cost yet.
			if (response.status === 404) return Option.none<GenerationCost>();
			const { data } = yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(GenerationAnswer)));
			const number = (value: unknown) => (Predicate.isNumber(value) ? value : undefined);
			const usd = number(data?.total_cost);
			return usd === undefined ? Option.none<GenerationCost>() : Option.some({ usd, inputTokens: number(data?.tokens_prompt) ?? 0, outputTokens: number(data?.tokens_completion) ?? 0 });
		});

	/** What OpenRouter billed for one generation. None while it can't tell yet, or when the request fails. */
	const generationCost = (generationId: string) =>
		Effect.gen(function* () {
			const key = yield* openRouterKey.key;
			return yield* askGeneration(generationId, key).pipe(Effect.timeout("5 seconds"));
		}).pipe(
			Effect.catchTags({ SqlError: (error) => Effect.fail(new Error(sqlMessage(error))) }),
			Effect.catch((error) =>
				Effect.as(Effect.logWarning(`model-calls: no cost from OpenRouter for generation ${generationId}:`, requestProblem(error)), Option.none<GenerationCost>()),
			),
		);

	const findCostless = SqlSchema.findAll({
		Request: Schema.Void,
		Result: CostRow,
		execute: () => sql`
			select id, generation_id from runs
			where generation_id is not null and cost_usd is null and finish_reason in ('interrupted', 'retried', 'failed', 'stopped')
				and created_at > now() - make_interval(days => ${COST_LOOKUP_DAYS})
				and (cost_next_at is null or cost_next_at <= now())
			order by coalesce(cost_next_at, created_at) limit ${COST_LOOKUPS_PER_SWEEP}`,
	});

	const fillCosts = Effect.gen(function* () {
		const rows = yield* findCostless(undefined).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		for (const row of rows) {
			const cost = yield* generationCost(row.generation_id);
			if (Option.isNone(cost)) {
				yield* sql`
					update runs set cost_tries = cost_tries + 1,
						cost_next_at = now() + make_interval(mins => least(power(2, cost_tries), ${MAX_COST_WAIT_MINUTES})::int)
					where id = ${row.id}`;
				continue;
			}
			yield* sql`
				update runs set cost_usd = ${cost.value.usd}, input_tokens = greatest(input_tokens, ${cost.value.inputTokens}),
					output_tokens = greatest(output_tokens, ${cost.value.outputTokens}), cost_tries = cost_tries + 1
				where id = ${row.id}`;
		}
	}).pipe(Effect.withSpan("ModelCalls.fillCosts"));

	return ModelCalls.of({ record, settleEarlierAttempts, settle, stop, fillCosts });
});

export const layer = Layer.effect(ModelCalls, make);
