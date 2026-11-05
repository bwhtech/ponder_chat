import { sql } from "./db.ts";
import { TITLE_FUNCTION_ID } from "./thread-title.ts";

/**
 * Daily credits. Each person may spend a number of credits a day, and the count starts
 * again at midnight UTC. A credit is a fixed slice of what OpenRouter charges: with the
 * default CHAT_CREDITS_PER_USD of 1000, one credit is $0.001. So a cheap model costs a
 * fraction of a credit per message and Claude Opus several credits.
 *
 * Spending is read from the `runs` table (telemetry), which records OpenRouter's cost
 * for every model call. Thread titles are recorded there too, but are not charged: the
 * app names threads, the person did not ask for it. Nothing is reserved up front: a person
 * with credits left can start a reply, and that one reply may take them past the limit.
 * The next one is refused. Replies have no length cap of their own: going over by one
 * reply is accepted.
 *
 * CHAT_DAILY_CREDITS sets everyone's limit. A row in `credit_limits` sets one person's.
 */
const DEFAULT_DAILY_CREDITS = Number(process.env.CHAT_DAILY_CREDITS ?? 100);
const CREDITS_PER_USD = Number(process.env.CHAT_CREDITS_PER_USD ?? 1000);

export type CreditStatus = {
	/** Credits a day. */
	limit: number;
	/** Spent since midnight UTC, rounded to one decimal place. */
	used: number;
	remaining: number;
	/** When the count starts again: the next midnight UTC, as an ISO date. */
	resetsAt: string;
};

export async function migrateCredits() {
	await sql`
		create table if not exists credit_limits (
			user_id text primary key,
			daily_credits integer not null,
			updated_at timestamptz not null default now()
		)`;
}

export async function creditStatus(user: string, now = new Date()): Promise<CreditStatus> {
	const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const resetsAt = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
	const [[spent], [override]] = await Promise.all([
		sql<{ usd: number }[]>`
			select coalesce(sum(cost_usd), 0)::float8 as usd from runs
			where "user" = ${user} and created_at >= ${dayStart}
				and function_id is distinct from ${TITLE_FUNCTION_ID}`,
		sql<{ daily_credits: number }[]>`select daily_credits from credit_limits where user_id = ${user}`,
	]);
	const limit = override?.daily_credits ?? DEFAULT_DAILY_CREDITS;
	const used = Math.round(spent.usd * CREDITS_PER_USD * 10) / 10;
	return { limit, used, remaining: Math.max(0, Math.round((limit - used) * 10) / 10), resetsAt: resetsAt.toISOString() };
}

/** Sets one person's daily limit, or with null, puts them back on the default. */
export async function setDailyCredits(user: string, credits: number | null) {
	if (credits === null) await sql`delete from credit_limits where user_id = ${user}`;
	else
		await sql`
			insert into credit_limits (user_id, daily_credits) values (${user}, ${credits})
			on conflict (user_id) do update set daily_credits = excluded.daily_credits, updated_at = now()`;
}
