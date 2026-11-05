import { sql } from "../db.ts";

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
};

/** A tool call without its input or output, which can hold site data. */
export type ToolCallRecord = {
	name: string;
	/** "pending" means the call did not run in this run: it waits for approval or an answer. */
	status: "ok" | "error" | "pending";
	ms?: number;
};

export async function migrateRuns() {
	await sql`
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
	await sql`create index if not exists runs_thread_idx on runs (thread_id, created_at)`;
	await sql`create index if not exists runs_user_idx on runs ("user", created_at)`;
}

export async function insertRun(run: RunRow) {
	await sql`
		insert into runs (id, parent_id, thread_id, "user", function_id, model, steps, input_tokens, output_tokens,
			cached_tokens, cost_usd, duration_ms, tool_calls, finish_reason)
		values (${run.id}, ${run.parentId}, ${run.threadId}, ${run.user}, ${run.functionId}, ${run.model}, ${run.steps},
			${run.inputTokens}, ${run.outputTokens}, ${run.cachedTokens}, ${run.costUsd}, ${run.durationMs},
			${sql.json(run.toolCalls as never)}, ${run.finishReason})
		on conflict (id) do nothing`;
}

/**
 * Read-only usage for `GET /api/usage?thread=`: a person's runs, for one thread or the latest 100,
 * with totals. Subagent runs carry the thread of the run that called them.
 */
export async function usageReport({ user, thread }: { user: string; thread?: string }) {
	const where = thread ? sql`"user" = ${user} and thread_id = ${thread}` : sql`"user" = ${user}`;
	const runs = await sql`
		select id, parent_id, thread_id, function_id, model, steps, input_tokens, output_tokens, cached_tokens,
			cost_usd::float8 as cost_usd, duration_ms, tool_calls, finish_reason, created_at
		from runs where ${where} order by created_at desc limit 100`;
	const [totals] = await sql`
		select count(*)::int as runs, coalesce(sum(input_tokens), 0)::int as input_tokens,
			coalesce(sum(output_tokens), 0)::int as output_tokens, coalesce(sum(cached_tokens), 0)::int as cached_tokens,
			coalesce(sum(cost_usd), 0)::float8 as cost_usd
		from runs where ${where}`;
	return { totals, runs };
}
