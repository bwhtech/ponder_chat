import { toCredits, utcDay } from "../credits.ts";
import { sql } from "../db.ts";
import { MODELS } from "../models.ts";
import { getSettings } from "../settings.ts";

/**
 * Usage for /admin, read from `charged_runs` (telemetry/store.ts): cost, model and time
 * only, never chat content. So credits and replies are counted as credits.ts counts them,
 * at today's credits per dollar.
 */
export type DayUsage = { credits: number; replies: number };

/** Each person's credits and replies per UTC day, over the last `days` days (today is the last). */
export class Usage {
	constructor(
		/** "2026-11-05", oldest first. */
		readonly dates: string[],
		private byUser: Map<string, Map<string, DayUsage>>,
	) {}

	static async load(days: number, user?: string) {
		const dates = lastDays(days);
		const { creditsPerUsd } = await getSettings();
		const rows = await sql<{ user: string; day: string; usd: number; replies: number }[]>`
			select "user", to_char((created_at at time zone 'utc')::date, 'YYYY-MM-DD') as day,
				coalesce(sum(cost_usd), 0)::float8 as usd, (count(*) filter (where is_reply))::int as replies
			from charged_runs
			where created_at >= ${new Date(`${dates[0]}T00:00:00Z`)} and "user" is not null ${user ? sql`and "user" = ${user}` : sql``}
			group by 1, 2`;
		const byUser = new Map<string, Map<string, DayUsage>>();
		for (const row of rows) {
			const days = byUser.get(row.user) ?? new Map<string, DayUsage>();
			days.set(row.day, { credits: toCredits(row.usd, creditsPerUsd), replies: row.replies });
			byUser.set(row.user, days);
		}
		return new Usage(dates, byUser);
	}

	get today() {
		return this.dates[this.dates.length - 1];
	}

	users() {
		return [...this.byUser.keys()];
	}

	day(user: string, date = this.today): DayUsage {
		return this.byUser.get(user)?.get(date) ?? { credits: 0, replies: 0 };
	}

	/** One person's days, oldest first, the last `days` of them. */
	series(user: string, days = this.dates.length) {
		return this.dates.slice(-days).map((date) => ({ date, ...this.day(user, date) }));
	}

	/** Totals over the last `days` days. */
	total(user: string, days = this.dates.length) {
		const series = this.series(user, days);
		return {
			credits: round(series.reduce((sum, day) => sum + day.credits, 0)),
			replies: series.reduce((sum, day) => sum + day.replies, 0),
			activeDays: series.filter((day) => day.replies > 0).length,
		};
	}

	/** Everyone together, per day: credits, replies, and how many people got a reply. */
	everyone(days = this.dates.length) {
		return this.dates.slice(-days).map((date) => {
			const used = this.users().map((user) => this.day(user, date));
			return {
				date,
				credits: round(used.reduce((sum, day) => sum + day.credits, 0)),
				replies: used.reduce((sum, day) => sum + day.replies, 0),
				active: used.filter((day) => day.replies > 0).length,
			};
		});
	}
}

/** Credits per model over the last `days` days, largest first, by the names people pick from. */
export async function creditsByModel(days: number, user?: string) {
	const { creditsPerUsd } = await getSettings();
	const rows = await sql<{ model: string; usd: number }[]>`
		select model, coalesce(sum(cost_usd), 0)::float8 as usd from charged_runs
		where created_at >= ${new Date(`${lastDays(days)[0]}T00:00:00Z`)} ${user ? sql`and "user" = ${user}` : sql``}
		group by 1`;
	const totals = new Map<string, number>();
	for (const row of rows) totals.set(modelName(row.model), (totals.get(modelName(row.model)) ?? 0) + row.usd);
	return [...totals]
		.map(([model, usd]) => ({ model, credits: Math.round(usd * creditsPerUsd) }))
		.filter((row) => row.credits > 0)
		.sort((a, b) => b.credits - a.credits);
}

/**
 * The limit for today of each person: their own limit or the default, plus today's
 * extra credits. Both tables are small, so they are read whole.
 */
export async function limitsToday() {
	const { defaultDailyCredits } = await getSettings();
	const [own, extra] = await Promise.all([
		sql<{ user_id: string; daily_credits: number }[]>`select user_id, daily_credits from credit_limits`,
		sql<{ user_id: string; credits: number }[]>`
			select user_id, sum(credits)::int as credits from credit_grants where day = ${utcDay().day} group by 1`,
	]);
	const ownLimit = new Map(own.map((row) => [row.user_id, row.daily_credits]));
	const extraToday = new Map(extra.map((row) => [row.user_id, row.credits]));
	return {
		defaultDailyCredits,
		/** null when the person is on the default. */
		own: (user: string) => ownLimit.get(user) ?? null,
		extra: (user: string) => extraToday.get(user) ?? 0,
		limit: (user: string) => (ownLimit.get(user) ?? defaultDailyCredits) + (extraToday.get(user) ?? 0),
	};
}

/** The last `days` UTC dates, oldest first. */
function lastDays(days: number) {
	const today = utcDay().start.getTime();
	return Array.from({ length: days }, (_, i) => new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** OpenRouter can answer with a dated id, such as "openai/gpt-6-luna-20261001". */
function modelName(id: string) {
	const model = MODELS.find((m) => id === m.id) ?? MODELS.filter((m) => id.startsWith(`${m.id}-`)).sort((a, b) => b.id.length - a.id.length)[0];
	return model?.name ?? id;
}

function round(value: number) {
	return Math.round(value * 10) / 10;
}
