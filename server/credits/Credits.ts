import * as PgClient from "@effect/sql-pg/PgClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { displayName } from "../admin/people.ts";
import * as Notify from "../notify/Notify.ts";
import * as Settings from "../settings/Settings.ts";
import * as ExtraCredits from "./ExtraCredits.ts";

/**
 * Daily credits. Each person may spend a number of credits a day, and the count starts
 * again at midnight UTC. A credit is a fixed slice of what OpenRouter charges: with
 * 1000 credits per US dollar, one credit is $0.001. So a cheap model costs a fraction
 * of a credit per message and Claude Opus several credits.
 *
 * Spending is read from `charged_runs` (telemetry/Runs.ts): the `runs` that OpenRouter
 * charged for, except thread titles, which the app makes and the person did not ask for. Nothing is reserved up front: a person
 * with credits left can start a reply. The credits are read again before each later model
 * call of the reply, and a person has at most a few replies in flight (workflow/replies.ts),
 * so going past the limit is bounded by the model calls already running.
 *
 * The default limit and the credits per dollar are in `settings` (settings/Settings.ts), which
 * admins change on /admin. A row in `credit_limits` sets one person's limit (from /admin,
 * an invite, or scripts/credits.ts). Extra credits for one day (ExtraCredits.ts) add to
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
	request: ExtraCredits.CreditRequest | null;
};

/** The person who asks for more credits (POST /api/credits/request): who they are, for the admins' alert. */
export type Asker = { id: string; name: string | null | undefined; email: string };

/** They asked already, and the admins have not answered yet. */
export class AlreadyAsked extends Schema.TaggedError<AlreadyAsked>()("AlreadyAsked", {}) {
	override get message() {
		return "You asked already. The admins have not answered yet.";
	}
}

/** They have credits left for today, so there is nothing to ask for. */
export class CreditsLeft extends Schema.TaggedError<CreditsLeft>()("CreditsLeft", {}) {
	override get message() {
		return "You still have credits for today.";
	}
}

// The columns as they come back: float8 and integer are numbers (cost_usd, a numeric, is
// summed and cast to float8 in the query), timestamptz a Date.
const SpentRow = Schema.Struct({ usd: Schema.Number });
const OwnRow = Schema.Struct({ daily_credits: Schema.Number });
const DailyCreditsRow = Schema.Struct({ email: Schema.String, daily_credits: Schema.Number, updated_at: Schema.Date });
const UserSince = Schema.Struct({ user: Schema.String, since: Schema.Date });

export type DailyCredits = typeof DailyCreditsRow.Type;

export class Credits extends Context.Service<
	Credits,
	{
		/** Creates the settings, limits, requests and grants tables. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** The person's credits for today, by the clock. */
		readonly status: (user: string) => Effect.Effect<CreditStatus, SqlError>;
		/**
		 * Asks the admins for more credits: records the request and sends them an alert, with
		 * a link to /admin at `origin`. The person's credits after it.
		 */
		readonly request: (asker: Asker, origin: string) => Effect.Effect<CreditStatus, AlreadyAsked | CreditsLeft | SqlError>;
		/** The person's own daily limit; none on the default. */
		readonly ownLimit: (user: string) => Effect.Effect<Option.Option<number>, SqlError>;
		/** Each person with their own limit, by email. */
		readonly listDailyCredits: Effect.Effect<ReadonlyArray<DailyCredits>, SqlError>;
		/** Sets one person's daily limit, or with null, puts them back on the default. */
		readonly setDailyCredits: (user: string, credits: number | null) => Effect.Effect<void, SqlError>;
	}
>()("ponder/credits/Credits") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const settings = yield* Settings.Settings;
	const extraCredits = yield* ExtraCredits.ExtraCredits;
	const notify = yield* Notify.Notify;

	const migrate = Effect.gen(function* () {
		yield* settings.migrate;
		yield* sql`
			create table if not exists credit_limits (
				user_id text primary key,
				daily_credits integer not null,
				updated_at timestamptz not null default now()
			)`;
		yield* extraCredits.migrate;
	});

	const findSpent = SqlSchema.findOne({
		Request: UserSince,
		Result: SpentRow,
		execute: ({ user, since }) => sql`
			select coalesce(sum(cost_usd), 0)::float8 as usd from charged_runs
			where "user" = ${user} and created_at >= ${since}`,
	});
	const findOwn = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: OwnRow,
		execute: (user) => sql`select daily_credits from credit_limits where user_id = ${user}`,
	});
	const findDailyCredits = SqlSchema.findAll({
		Request: Schema.Void,
		Result: DailyCreditsRow,
		execute: () => sql`
			select users.email, credit_limits.daily_credits, credit_limits.updated_at
			from credit_limits join users on users.id = credit_limits.user_id order by users.email`,
	});

	const ownLimit = Effect.fn("Credits.ownLimit")(function* (user: string) {
		const row = yield* findOwn(user).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.map(row, (found) => found.daily_credits);
	});

	const status = Effect.fn("Credits.status")(function* (user: string) {
		const { start, day, resetsAt } = utcDay(new Date(yield* Clock.currentTimeMillis));
		const { current, spent, own, extra, request } = yield* Effect.all(
			{
				current: settings.get,
				// A sum always has a row; one that does not decode is not Ponder's database.
				spent: findSpent({ user, since: start }).pipe(Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die })),
				own: ownLimit(user),
				extra: extraCredits.extraCredits(user, day),
				request: extraCredits.currentRequest(user, start),
			},
			{ concurrency: "unbounded" },
		);
		const limit = Option.getOrElse(own, () => current.defaultDailyCredits) + extra;
		const used = toCredits(spent.usd, current.creditsPerUsd);
		return {
			limit,
			used,
			remaining: Math.max(0, Math.round((limit - used) * 10) / 10),
			resetsAt: resetsAt.toISOString(),
			extra,
			request,
		} satisfies CreditStatus;
	});

	const request = Effect.fn("Credits.request")(function* (asker: Asker, origin: string) {
		const before = yield* status(asker.id);
		if (before.request?.status === "pending") return yield* new AlreadyAsked();
		if (before.remaining > 0) return yield* new CreditsLeft();
		if (Option.isNone(yield* extraCredits.ask(asker.id))) return yield* new AlreadyAsked();
		const used = before.used >= 100 ? Math.round(before.used) : before.used;
		const message = `${displayName(asker.name ?? null, asker.email)} asked for more credits (${used} of ${before.limit} used today).`;
		yield* notify.admins("Ponder Chat: credit request", message, `${origin}/admin/requests`);
		return yield* status(asker.id);
	});

	const listDailyCredits = findDailyCredits(undefined).pipe(Effect.catchTags({ SchemaError: Effect.die }), Effect.withSpan("Credits.listDailyCredits"));

	const setDailyCredits = Effect.fn("Credits.setDailyCredits")(function* (user: string, credits: number | null) {
		if (credits === null) yield* sql`delete from credit_limits where user_id = ${user}`;
		else
			yield* sql`
				insert into credit_limits (user_id, daily_credits) values (${user}, ${credits})
				on conflict (user_id) do update set daily_credits = excluded.daily_credits, updated_at = now()`;
	});

	return Credits.of({ migrate, status, request, ownLimit, listDailyCredits, setDailyCredits });
});

export const layer = Layer.effect(Credits, make);

/** Credits for a cost in US dollars, rounded to one decimal place. */
export function toCredits(usd: number, creditsPerUsd: number) {
	return Math.round(usd * creditsPerUsd * 10) / 10;
}

/** The UTC day of `now`: when it started, its date ("2026-11-05"), and when the next one starts. */
export function utcDay(now: Date) {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	return { start, day: start.toISOString().slice(0, 10), resetsAt: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}
