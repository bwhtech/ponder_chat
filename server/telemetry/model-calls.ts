import { sql } from "../db.ts";
import { openRouterKey } from "../openrouter-key.ts";
import { openRouterUrl } from "../openrouter.ts";
import type { UNCHARGED_CALLS } from "./store.ts";

/**
 * The `runs` row of each attempt at a reply's model call (workflow/model-attempt.ts).
 * Credits are charged from these rows (store.ts, `charged_runs`).
 *
 * The row is written when OpenRouter's first chunk names the call (its generation id),
 * so a call that a crash cuts short is still in `runs`. When the attempt ends, the row
 * gets its tokens and cost. An attempt that failed, or that a crash or Stop cut short,
 * costs no credits. A stream cut short does not report its cost, so the sweep gets it
 * from OpenRouter's generation API later (fillModelCallCosts), off the reply's path.
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

/** The most rows one sweep looks up, and how long OpenRouter keeps trying to report a cost. */
const COST_LOOKUPS_PER_SWEEP = 50;
const COST_LOOKUP_DAYS = 1;

export class ModelCallRecord {
	private generationId: string | undefined;
	private readonly startedAt = Date.now();

	constructor(
		readonly id: string,
		private readonly context: { threadId: string; user: string; model: string },
	) {}

	static id(runId: string, stepId: string, attempt: number) {
		return `${runId}:${stepId}:${attempt}`;
	}

	/** The call has begun on OpenRouter, and may be billed from now on. */
	async start(generationId: string) {
		this.generationId = generationId;
		const { threadId, user, model } = this.context;
		await sql`
			insert into runs (id, parent_id, thread_id, "user", function_id, model, steps, input_tokens, output_tokens,
				cached_tokens, cost_usd, duration_ms, tool_calls, finish_reason, generation_id)
			values (${this.id}, null, ${threadId}, ${user}, 'chat', ${model}, 1, 0, 0, 0, null, 0, '[]', 'started', ${generationId})
			on conflict (id) do nothing`;
	}

	/**
	 * The call finished: its tokens and cost. A call that Stop cut short keeps them but
	 * stays uncharged ("stopped"): Stop marked its row (stopModelCalls), or its run is
	 * cancelled (`stopped`).
	 */
	async finish(usage: CallUsage, { stopped }: { stopped: boolean }) {
		const { threadId, user } = this.context;
		const finishReason = stopped ? ("stopped" satisfies Uncharged) : usage.finishReason;
		const toolCalls = sql.json(usage.toolCalls.map((name) => ({ name, status: "ok" })) as never);
		await sql`
			insert into runs (id, parent_id, thread_id, "user", function_id, model, steps, input_tokens, output_tokens,
				cached_tokens, cost_usd, duration_ms, tool_calls, finish_reason, generation_id)
			values (${this.id}, null, ${threadId}, ${user}, 'chat', ${usage.model}, 1, ${usage.inputTokens}, ${usage.outputTokens},
				${usage.cachedTokens}, ${usage.costUsd}, ${Date.now() - this.startedAt}, ${toolCalls}, ${finishReason}, ${this.generationId ?? null})
			on conflict (id) do update set model = excluded.model, input_tokens = excluded.input_tokens,
				output_tokens = excluded.output_tokens, cached_tokens = excluded.cached_tokens, cost_usd = excluded.cost_usd,
				duration_ms = excluded.duration_ms, tool_calls = excluded.tool_calls,
				finish_reason = case when runs.finish_reason = 'stopped' then 'stopped' else excluded.finish_reason end
			where runs.finish_reason in ('started', 'stopped')`;
	}

	/** The attempt failed. Only a call that OpenRouter began (start) can be billed, so only it has a row. */
	async fail(finishReason: Extract<Uncharged, "retried" | "failed">) {
		if (!this.generationId) return;
		await sql`
			update runs set duration_ms = ${Date.now() - this.startedAt},
				finish_reason = case when finish_reason = 'stopped' then 'stopped' else ${finishReason} end
			where id = ${this.id} and finish_reason in ('started', 'stopped')`;
	}
}

/**
 * Before an attempt that is not the first: the earlier attempts of the same model call.
 * One cut by a crash still says "started", and becomes "interrupted". One that finished,
 * but whose result the step lost because the server stopped before it saved it, becomes
 * "retried": this attempt replaces it, so only this one may be charged.
 */
export async function settleEarlierAttempts(threadId: string, runId: string, stepId: string, current: string) {
	await sql`
		update runs set finish_reason = case when finish_reason = 'started' then 'interrupted' else 'retried' end
		where thread_id = ${threadId} and id like ${`${runId}:${stepId}:%`} and id <> ${current}
			and finish_reason not in ('interrupted', 'retried', 'failed', 'stopped')`;
}

/**
 * The run's model calls that a crash cut short on their last attempt: nothing ran again
 * to settle them. Called when the run saves its reply.
 */
export async function settleModelCalls(threadId: string, runId: string) {
	await sql`
		update runs set finish_reason = 'interrupted'
		where thread_id = ${threadId} and id like ${`${runId}:%`} and finish_reason = 'started'`;
}

/** After Stop: the run's calls in flight are uncharged, even when they finish later. */
export async function stopModelCalls(threadId: string, runId: string) {
	await sql`
		update runs set finish_reason = 'stopped'
		where thread_id = ${threadId} and id like ${`${runId}:%`} and finish_reason = 'started'`;
}

/**
 * Gets the cost of model calls that ended without it, from OpenRouter's generation API.
 * Run by the sweep (workflow/sweep.ts). OpenRouter can take a few seconds to have a
 * generation's cost, so a call it can't tell about yet is asked again by the next sweep,
 * for up to COST_LOOKUP_DAYS. Newest first: a generation that OpenRouter never reports
 * can't keep the newer ones waiting.
 */
export async function fillModelCallCosts() {
	const rows = await sql<{ id: string; generation_id: string }[]>`
		select id, generation_id from runs
		where generation_id is not null and cost_usd is null and finish_reason in ('interrupted', 'retried', 'failed', 'stopped')
			and created_at > now() - make_interval(days => ${COST_LOOKUP_DAYS})
		order by created_at desc limit ${COST_LOOKUPS_PER_SWEEP}`;
	for (const row of rows) {
		const cost = await generationCost(row.generation_id);
		if (!cost) continue;
		await sql`
			update runs set cost_usd = ${cost.usd}, input_tokens = greatest(input_tokens, ${cost.inputTokens}),
				output_tokens = greatest(output_tokens, ${cost.outputTokens})
			where id = ${row.id}`;
	}
}

/** What OpenRouter billed for one generation. Null while it can't tell yet, or when the request fails. */
async function generationCost(generationId: string): Promise<{ usd: number; inputTokens: number; outputTokens: number } | null> {
	try {
		const response = await fetch(openRouterUrl(`v1/generation?id=${encodeURIComponent(generationId)}`), {
			headers: { Authorization: `Bearer ${await openRouterKey()}` },
			signal: AbortSignal.timeout(5_000),
		});
		// 404: OpenRouter does not have the generation's cost yet.
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const { data } = (await response.json()) as { data?: { total_cost?: number; tokens_prompt?: number; tokens_completion?: number } };
		return typeof data?.total_cost === "number" ? { usd: data.total_cost, inputTokens: data.tokens_prompt ?? 0, outputTokens: data.tokens_completion ?? 0 } : null;
	} catch (error) {
		console.warn(`model-calls: no cost from OpenRouter for generation ${generationId}:`, error instanceof Error ? error.message : error);
		return null;
	}
}
