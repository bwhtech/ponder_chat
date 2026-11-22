import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

/** The `function_id` of the calls that name threads. The app makes them, not the person, so they cost no credits. */
export const TITLE_FUNCTION_ID = "thread-title";

/**
 * The calls the app makes, not one person's reply (docs/workspaces-plan.md, "System
 * spend"). Each is kept in `runs` with the person who caused it, so admins can see the
 * spend, and none costs credits: `charged_runs` leaves them out.
 */
export const SYSTEM_FUNCTION_IDS = [
	TITLE_FUNCTION_ID,
	// Memories and memory searches (memory/pgvector-index.ts).
	"memory-embed",
	// A workspace document's passages, one row for each batch (workspaces/documents/Indexer.ts).
	"workspace-index",
	// A picture page of a workspace PDF, read by a model.
	"workspace-pdf",
	// The question of a workspace search, in a chat.
	"workspace-search",
] as const;
export type SystemFunctionId = (typeof SYSTEM_FUNCTION_IDS)[number];
/** The calls that summarize a long chat (compaction/summarize.ts). The person's reply needs them, so they cost credits. */
export const COMPACTION_FUNCTION_ID = "compaction";

/**
 * How a reply's model call ends when it did not finish (ModelCalls.ts): still running or
 * cut by a crash ("started"), cut by a crash and settled ("interrupted"), tried again
 * ("retried"), or failed on its last attempt ("failed"). OpenRouter may bill them, so they
 * are kept, but they cost the person no credits. A call cut by Stop ("stopped") does cost
 * credits: it runs to its end on OpenRouter, and the person read what it wrote.
 */
export const UNCHARGED_CALLS = ["started", "interrupted", "retried", "failed"] as const;

/** One agent run: one generateText/streamText call, such as one /api/chat request or one subagent call. */
export type RunRow = {
	id: string;
	parentId: string | null;
	threadId: string | null;
	user: string | null;
	functionId: string | null;
	model: string;
	steps: number;
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
	costUsd: number | null;
	durationMs: number;
	toolCalls: ToolCallRecord[];
	finishReason: string;
	/** OpenRouter's id of the call, when its cost may come later (ModelCalls.fillCosts). */
	generationId?: string | null;
};

/** A tool call without its input or output, which can hold site data. */
export type ToolCallRecord = {
	name: string;
	/** "pending" means the call did not run in this run: it waits for approval or an answer. */
	status: "ok" | "error" | "pending";
	ms?: number;
};

// GET /api/usage. Its columns as they come back: int4 and float8 are numbers (cost_usd, a
// numeric, is cast to float8 in the query), timestamptz a Date, jsonb parsed.
const UsageRun = Schema.Struct({
	id: Schema.String,
	parent_id: Schema.NullOr(Schema.String),
	thread_id: Schema.NullOr(Schema.String),
	function_id: Schema.NullOr(Schema.String),
	model: Schema.String,
	steps: Schema.Number,
	input_tokens: Schema.Number,
	output_tokens: Schema.Number,
	cached_tokens: Schema.Number,
	cost_usd: Schema.NullOr(Schema.Number),
	duration_ms: Schema.Number,
	// As saved: older rows may have another shape, and the list shows them as they are.
	tool_calls: Schema.Unknown,
	finish_reason: Schema.String,
	created_at: Schema.Date,
});
const UsageTotals = Schema.Struct({
	runs: Schema.Number,
	input_tokens: Schema.Number,
	output_tokens: Schema.Number,
	cached_tokens: Schema.Number,
	cost_usd: Schema.Number,
});
const UsageQuery = Schema.Struct({ user: Schema.String, thread: Schema.optional(Schema.String) });

export type UsageReport = { totals: typeof UsageTotals.Type; runs: ReadonlyArray<typeof UsageRun.Type> };

export class Runs extends Context.Service<
	Runs,
	{
		/** Creates and updates `runs`, its indexes, and the `charged_runs` view. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** Saves a run, once: a second run with the same id is left out. */
		readonly insert: (run: RunRow) => Effect.Effect<void, SqlError>;
		/**
		 * Read-only usage for `GET /api/usage?thread=`: a person's runs, for one thread or the latest 100,
		 * with totals. Subagent runs carry the thread of the run that called them. The list has
		 * every row; the totals leave out the model calls that cost no credits (UNCHARGED_CALLS)
		 * and the app's own calls (SYSTEM_FUNCTION_IDS), which cost the person nothing.
		 */
		readonly usageReport: (query: { user: string; thread?: string }) => Effect.Effect<UsageReport, SqlError>;
	}
>()("ponder/telemetry/Runs") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;

	/**
	 * `charged_runs`: the runs that cost the person credits, with `is_reply` on the run that
	 * ended a reply. The one place for these two rules: credits.ts, the /admin usage and
	 * deploy/sentinel.sh all read this view.
	 *
	 * A reply writes one "chat" run per model call; the calls before the last end in
	 * "tool-calls", so only the last one is the reply; a call cut by Stop is charged but is
	 * not a finished reply. Web searches, memory and titles have their own function_id; the
	 * app's own calls (SYSTEM_FUNCTION_IDS) cost no credits. Model calls that a crash or an
	 * error cut short are kept in `runs` but cost no credits (UNCHARGED_CALLS, ModelCalls.ts).
	 * The view is made again at each start, because `runs.*` changes when `runs` gets a column.
	 */
	const migrateChargedRuns = sql.withTransaction(
		Effect.gen(function* () {
			yield* sql`drop view if exists charged_runs`;
			// A view's query can't take parameters, so the constant goes in as text.
			yield* sql.unsafe(`
				create view charged_runs as
				select runs.*, (function_id = 'chat' and parent_id is null and finish_reason not in ('tool-calls', 'stopped')) as is_reply
				from runs where coalesce(function_id, '') not in (${quoted(SYSTEM_FUNCTION_IDS)})
					and finish_reason not in (${quoted(UNCHARGED_CALLS)})`);
		}),
	);

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists runs (
				id text primary key,
				parent_id text,
				thread_id text,
				"user" text,
				function_id text,
				model text not null,
				steps integer not null,
				input_tokens integer not null,
				output_tokens integer not null,
				cached_tokens integer not null,
				cost_usd numeric(12, 6),
				duration_ms integer not null,
				tool_calls jsonb not null default '[]',
				finish_reason text not null,
				created_at timestamptz not null default now()
			)`;
		yield* sql`create index if not exists runs_thread_idx on runs (thread_id, created_at)`;
		yield* sql`create index if not exists runs_user_idx on runs ("user", created_at)`;
		// Everyone's runs over a range of days: the /admin overview, people and requests, and deploy/sentinel.sh.
		yield* sql`create index if not exists runs_created_idx on runs (created_at)`;
		// OpenRouter's id for a reply's model call, to look up the cost of a call cut short (ModelCalls.ts).
		yield* sql`alter table runs add column if not exists generation_id text`;
		// How often the sweep asked OpenRouter for that cost, and when it asks next (ModelCalls.ts).
		yield* sql`alter table runs add column if not exists cost_tries integer not null default 0`;
		yield* sql`alter table runs add column if not exists cost_next_at timestamptz`;
		yield* migrateChargedRuns;
	});

	const insert = Effect.fn("Runs.insert")(function* (run: RunRow) {
		yield* sql`
			insert into runs (id, parent_id, thread_id, "user", function_id, model, steps, input_tokens, output_tokens,
				cached_tokens, cost_usd, duration_ms, tool_calls, finish_reason, generation_id)
			values (${run.id}, ${run.parentId}, ${run.threadId}, ${run.user}, ${run.functionId}, ${run.model}, ${run.steps},
				${run.inputTokens}, ${run.outputTokens}, ${run.cachedTokens}, ${run.costUsd}, ${run.durationMs},
				${sql.json(run.toolCalls)}, ${run.finishReason}, ${run.generationId ?? null})
			on conflict (id) do nothing`;
	});

	const where = ({ user, thread }: typeof UsageQuery.Type) => (thread !== undefined ? sql`"user" = ${user} and thread_id = ${thread}` : sql`"user" = ${user}`);

	const findRuns = SqlSchema.findAll({
		Request: UsageQuery,
		Result: UsageRun,
		execute: (query) => sql`
			select id, parent_id, thread_id, function_id, model, steps, input_tokens, output_tokens, cached_tokens,
				cost_usd::float8 as cost_usd, duration_ms, tool_calls, finish_reason, created_at
			from runs where ${where(query)} order by created_at desc limit 100`,
	});
	const findTotals = SqlSchema.findOneOption({
		Request: UsageQuery,
		Result: UsageTotals,
		execute: (query) => sql`
			select count(*)::int as runs, coalesce(sum(input_tokens), 0)::int as input_tokens,
				coalesce(sum(output_tokens), 0)::int as output_tokens, coalesce(sum(cached_tokens), 0)::int as cached_tokens,
				coalesce(sum(cost_usd), 0)::float8 as cost_usd
			from runs where ${where(query)} and finish_reason <> all(${[...UNCHARGED_CALLS]})
				and coalesce(function_id, '') <> all(${[...SYSTEM_FUNCTION_IDS]})`,
	});

	const usageReport = Effect.fn("Runs.usageReport")(function* (query: { user: string; thread?: string }) {
		// postgres.js's `thread ?` left an empty thread out, as no thread.
		const asked = { user: query.user, ...(query.thread ? { thread: query.thread } : {}) };
		const [runs, totals] = yield* Effect.all([findRuns(asked), findTotals(asked).pipe(Effect.flatMap(Effect.fromOption))], { concurrency: "unbounded" }).pipe(
			// An aggregate always gives one row, and the columns are Ponder's: a row that does not decode is a bug.
			Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die }),
		);
		return { totals, runs };
	});

	return Runs.of({ migrate, insert, usageReport });
});

export const layer = Layer.effect(Runs, make);

/** Constants into a view's SQL, which can't take parameters. */
function quoted(values: ReadonlyArray<string>) {
	return values.map((value) => `'${value}'`).join(", ");
}
