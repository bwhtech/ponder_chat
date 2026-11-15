import { sql } from "./db.ts";
import { currentRequest, extraCredits, migrateExtraCredits, type CreditRequest } from "./extra-credits.ts";
import { runPromise } from "./runtime/runtime.ts";
import * as Settings from "./settings/Settings.ts";

/**
 * Daily credits. Each person may spend a number of credits a day, and the count starts
 * again at midnight UTC. A credit is a fixed slice of what OpenRouter charges: with
 * 1000 credits per US dollar, one credit is $0.001. So a cheap model costs a fraction
 * of a credit per message and Claude Opus several credits.
 *
 * Spending is read from `charged_runs` (telemetry/Runs.ts): the `runs` that OpenRouter
 * charged for, except thread titles, which the app makes and the person did not ask for. Nothing is reserved up front: a person
 * with credits left can start a reply, and that one reply may take them past the limit.
 * The next one is refused. Replies have no length cap of their own: going over by one
 * reply is accepted.
 *
 * The default limit and the credits per dollar are in `settings` (settings/Settings.ts), which
 * admins change on /admin. A row in `credit_limits` sets one person's limit (from /admin,
 * an invite, or scripts/credits.ts). Extra credits for one day (extra-credits.ts) add to
 * the limit.
 */
export type CreditStatus = {
	/** Credits for today: the person's own limit or the default, plus `extra`. */
	limit: number;
	/** Spent since midnight UTC, rounded to one decimal place. */
	used: number;
	remaining: number;
	/** When the count starts again: the next midnight UTC, as an ISO date. */
	resetsAt: string;
	/** Extra credits that admins gave for today. */
	extra: number;
	/** The request for more credits that is waiting, or the one answered today. */
	request: CreditRequest | null;
};

export async function migrateCredits() {
	await runPromise(Settings.Settings.use((settings) => settings.migrate));
	await sql`
		create table if not exists credit_limits (
			user_id text primary key,
			daily_credits integer not null,
			updated_at timestamptz not null default now()
		)`;
	await migrateExtraCredits();
}

export async function creditStatus(user: string, now = new Date()): Promise<CreditStatus> {
	const { start, day, resetsAt } = utcDay(now);
	const [settings, [spent], [own], extra, request] = await Promise.all([
		runPromise(Settings.Settings.use((settings) => settings.get)),
		sql<{ usd: number }[]>`
			select coalesce(sum(cost_usd), 0)::float8 as usd from charged_runs
			where "user" = ${user} and created_at >= ${start}`,
		sql<{ daily_credits: number }[]>`select daily_credits from credit_limits where user_id = ${user}`,
		extraCredits(user, day),
		currentRequest(user, start),
	]);
	const limit = (own?.daily_credits ?? settings.defaultDailyCredits) + extra;
	const used = toCredits(spent.usd, settings.creditsPerUsd);
	return {
		limit,
		used,
		remaining: Math.max(0, Math.round((limit - used) * 10) / 10),
		resetsAt: resetsAt.toISOString(),
		extra,
		request,
	};
}

/** Credits for a cost in US dollars, rounded to one decimal place. */
export function toCredits(usd: number, creditsPerUsd: number) {
	return Math.round(usd * creditsPerUsd * 10) / 10;
}

/** Today in UTC: when it started, its date ("2026-11-05"), and when the next one starts. */
export function utcDay(now = new Date()) {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	return { start, day: start.toISOString().slice(0, 10), resetsAt: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** Each person with their own limit, by email. */
export async function listDailyCredits() {
	return sql<{ email: string; daily_credits: number; updated_at: Date }[]>`
		select users.email, credit_limits.daily_credits, credit_limits.updated_at
		from credit_limits join users on users.id = credit_limits.user_id order by users.email`;
}

/** Sets one person's daily limit, or with null, puts them back on the default. */
export async function setDailyCredits(user: string, credits: number | null) {
	if (credits === null) await sql`delete from credit_limits where user_id = ${user}`;
	else
		await sql`
			insert into credit_limits (user_id, daily_credits) values (${user}, ${credits})
			on conflict (user_id) do update set daily_credits = excluded.daily_credits, updated_at = now()`;
}
