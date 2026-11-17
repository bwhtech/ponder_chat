import { toCredits } from "../credits/Credits.ts";
import { MODELS } from "../models/Models.ts";
import { SYSTEM_FUNCTION_IDS, type SystemFunctionId } from "../telemetry/Runs.ts";

/**
 * Usage for /admin, read from `charged_runs` (telemetry/Runs.ts) by AdminReports.ts: cost,
 * model and time only, never chat content. So credits and replies are counted as
 * credits/Credits.ts counts them, at today's credits per dollar.
 *
 * Plain code: AdminReports.ts reads the rows and gives the dates.
 */
export type DayUsage = { credits: number; replies: number };

/** One person's spending on one UTC day, as the query sums it. */
export type UsageRow = { user: string; day: string; usd: number; replies: number };

/** Each person's credits and replies per UTC day, over the last `days` days (today is the last). */
export class Usage {
	private byUser = new Map<string, Map<string, DayUsage>>();

	constructor(
		/** "2026-11-05", oldest first. */
		readonly dates: string[],
		rows: ReadonlyArray<UsageRow>,
		creditsPerUsd: number,
	) {
		for (const row of rows) {
			const days = this.byUser.get(row.user) ?? new Map<string, DayUsage>();
			days.set(row.day, { credits: toCredits(row.usd, creditsPerUsd), replies: row.replies });
			this.byUser.set(row.user, days);
		}
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

/**
 * The limit for today of each person: their own limit or the default, plus today's
 * extra credits.
 */
export type Limits = ReturnType<typeof limitsOf>;

export function limitsOf(
	defaultDailyCredits: number,
	own: ReadonlyArray<{ user_id: string; daily_credits: number }>,
	extra: ReadonlyArray<{ user_id: string; credits: number }>,
) {
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

/** Credits per model, largest first, by the names people pick from. */
export function byModel(rows: ReadonlyArray<{ model: string; usd: number }>, creditsPerUsd: number) {
	const totals = new Map<string, number>();
	for (const row of rows) totals.set(modelName(row.model), (totals.get(modelName(row.model)) ?? 0) + row.usd);
	return [...totals]
		.map(([model, usd]) => ({ model, credits: Math.round(usd * creditsPerUsd) }))
		.filter((row) => row.credits > 0)
		.sort((a, b) => b.credits - a.credits);
}

/**
 * What the app's own calls cost (docs/workspaces-plan.md, "System spend"): chat names,
 * memory and workspace embeddings, picture pages. Read from `runs`, not `charged_runs`, in
 * US dollars: they cost no one credits. Every system function id is listed, with 0 when
 * it made no call, largest cost first.
 */
export type SystemSpend = { usd: number; calls: number; byFunction: { functionId: SystemFunctionId; usd: number; calls: number }[] };

export function systemSpend(rows: ReadonlyArray<{ function_id: string; usd: number; calls: number }>): SystemSpend {
	const byFunction = SYSTEM_FUNCTION_IDS.map((functionId) => {
		const row = rows.find((found) => found.function_id === functionId);
		return { functionId, usd: roundUsd(row?.usd ?? 0), calls: row?.calls ?? 0 };
	}).sort((a, b) => b.usd - a.usd || b.calls - a.calls);
	return {
		usd: roundUsd(byFunction.reduce((sum, row) => sum + row.usd, 0)),
		calls: byFunction.reduce((sum, row) => sum + row.calls, 0),
		byFunction,
	};
}

/** The last `days` UTC dates up to the day that starts at `today`, oldest first. */
export function lastDays(days: number, today: Date) {
	const start = today.getTime();
	return Array.from({ length: days }, (_, i) => new Date(start - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** OpenRouter can answer with a dated id, such as "openai/gpt-6-luna-20261001". */
function modelName(id: string) {
	const model = MODELS.find((m) => id === m.id) ?? MODELS.filter((m) => id.startsWith(`${m.id}-`)).sort((a, b) => b.id.length - a.id.length)[0];
	return model?.name ?? id;
}

function round(value: number) {
	return Math.round(value * 10) / 10;
}

/** `runs.cost_usd` keeps 6 places; sums of floats get more. */
function roundUsd(value: number) {
	return Math.round(value * 1e6) / 1e6;
}
