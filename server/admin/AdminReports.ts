import * as PgClient from "@effect/sql-pg/PgClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { utcDay } from "../credits/Credits.ts";
import * as ExtraCredits from "../credits/ExtraCredits.ts";
import * as Invites from "../people/Invites.ts";
import * as Settings from "../settings/Settings.ts";
import { type Activity, type Named, PAGE, toActivity, unknownTarget } from "./activity.ts";
import * as AdminEvents from "./AdminEvents.ts";
import { deviceName, displayName, type Person, PersonRow, toPerson } from "./people.ts";
import { byModel, lastDays, limitsOf, Usage } from "./usage.ts";

/**
 * What /admin reads (admin/routes.ts): its sidebar's counts, the Overview, People,
 * Requests and Activity pages. Usage numbers only: nothing here reads messages or
 * thread titles.
 */
export type ActivityPage = { events: Activity[]; next: number | null; person: Named | null };

const NamedRow = Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String });
const UsageRow = Schema.Struct({ user: Schema.String, day: Schema.String, usd: Schema.Number, replies: Schema.Number });
const ModelRow = Schema.Struct({ model: Schema.String, usd: Schema.Number });
const OwnRow = Schema.Struct({ user_id: Schema.String, daily_credits: Schema.Number });
const ExtraRow = Schema.Struct({ user_id: Schema.String, credits: Schema.Number });
const SessionRow = Schema.Struct({ user_agent: Schema.NullOr(Schema.String), updated_at: Schema.Date });
const CountRow = Schema.Struct({ count: Schema.Number });
const Since = Schema.Struct({ since: Schema.Date, user: Schema.optional(Schema.String) });

export class AdminReports extends Context.Service<
	AdminReports,
	{
		/** For the sidebar's counts. */
		readonly summary: Effect.Effect<{ pendingRequests: number; invited: number }, SqlError>;
		/** The Overview page: today, the last `days` days, models, and who uses Ponder. */
		readonly overview: (days: number) => Effect.Effect<Overview, SqlError>;
		/** Everyone with an account, then everyone invited without one. */
		readonly people: Effect.Effect<Person[], SqlError>;
		/** One person, by user id or (for an invite) by email, with 30 days of usage, models, sessions and chats. */
		readonly person: (id: string) => Effect.Effect<Option.Option<PersonDetail>, SqlError>;
		/** The Requests page: requests waiting for an answer, and those answered in the last 30 days. */
		readonly requests: Effect.Effect<RequestsReport, SqlError>;
		/**
		 * A page of the admin activity log, newest first. `person` keeps the events done by or
		 * to one person. `next` is the `olderThan` for the page after, or null on the last page.
		 */
		readonly activity: (query: { olderThan?: number; person?: string }) => Effect.Effect<ActivityPage, SqlError>;
		/** The admins, named, oldest account first. */
		readonly admins: Effect.Effect<Named[], SqlError>;
	}
>()("ponder/admin/AdminReports") {}

type Overview = Effect.Success<ReturnType<ReturnType<typeof makeOverview>>>;
type PersonDetail = Effect.Success<ReturnType<ReturnType<typeof makePerson>>> extends Option.Option<infer A> ? A : never;
type RequestsReport = Effect.Success<ReturnType<typeof makeRequests>>;

/** The reads the reports share. */
const makeReads = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const settings = yield* Settings.Settings;

	const findUsage = SqlSchema.findAll({
		Request: Since,
		Result: UsageRow,
		execute: ({ since, user }) => sql`
			select "user", to_char((created_at at time zone 'utc')::date, 'YYYY-MM-DD') as day,
				coalesce(sum(cost_usd), 0)::float8 as usd, (count(*) filter (where is_reply))::int as replies
			from charged_runs
			where created_at >= ${since} and "user" is not null ${user ? sql`and "user" = ${user}` : sql``}
			group by 1, 2`,
	});
	const findModels = SqlSchema.findAll({
		Request: Since,
		Result: ModelRow,
		execute: ({ since, user }) => sql`
			select model, coalesce(sum(cost_usd), 0)::float8 as usd from charged_runs
			where created_at >= ${since} ${user ? sql`and "user" = ${user}` : sql``}
			group by 1`,
	});
	const findOwn = SqlSchema.findAll({ Request: Schema.Void, Result: OwnRow, execute: () => sql`select user_id, daily_credits from credit_limits` });
	const findExtra = SqlSchema.findAll({
		Request: Schema.String,
		Result: ExtraRow,
		execute: (day) => sql`select user_id, sum(credits)::int as credits from credit_grants where day = ${day} group by 1`,
	});
	const findNames = SqlSchema.findAll({
		Request: Schema.Array(Schema.String),
		Result: NamedRow,
		execute: (ids) => sql`select id, name, email from users where id in ${sql.in(ids)}`,
	});

	/** Today's start (midnight UTC), by the clock. */
	const today = Effect.map(Clock.currentTimeMillis, (now) => utcDay(new Date(now)).start);

	/** Each person's credits and replies per UTC day, over the last `days` days (today is the last). */
	const usage = Effect.fn("AdminReports.usage")(function* (days: number, user?: string) {
		const dates = lastDays(days, yield* today);
		const { creditsPerUsd } = yield* settings.get;
		const rows = yield* findUsage({ since: new Date(`${dates[0]}T00:00:00Z`), user }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return new Usage(dates, rows, creditsPerUsd);
	});

	/** Credits per model over the last `days` days, largest first, by the names people pick from. */
	const creditsByModel = Effect.fn("AdminReports.creditsByModel")(function* (days: number, user?: string) {
		const { creditsPerUsd } = yield* settings.get;
		const since = new Date(`${lastDays(days, yield* today)[0]}T00:00:00Z`);
		const rows = yield* findModels({ since, user }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return byModel(rows, creditsPerUsd);
	});

	/** The limit for today of each person. Both tables are small, so they are read whole. */
	const limitsToday = Effect.gen(function* () {
		const { defaultDailyCredits } = yield* settings.get;
		const day = utcDay(new Date(yield* Clock.currentTimeMillis)).day;
		const { own, extra } = yield* Effect.all({ own: findOwn(undefined), extra: findExtra(day) }, { concurrency: "unbounded" }).pipe(
			Effect.catchTags({ SchemaError: Effect.die }),
		);
		return limitsOf(defaultDailyCredits, own, extra);
	}).pipe(Effect.withSpan("AdminReports.limitsToday"));

	/** Names and emails for a list of user ids, for requests and the admins list. */
	const namesOf = Effect.fn("AdminReports.namesOf")(function* (ids: ReadonlyArray<string>) {
		const rows = ids.length ? yield* findNames(ids).pipe(Effect.catchTags({ SchemaError: Effect.die })) : [];
		return new Map(rows.map((row): [string, Named] => [row.id, { id: row.id, name: displayName(row.name, row.email), email: row.email }]));
	});

	return { sql, settings, usage, creditsByModel, limitsToday, namesOf };
});

type Reads = Effect.Success<typeof makeReads>;

function makeOverview({ sql, settings, usage, creditsByModel, limitsToday }: Reads, extraCredits: ExtraCredits.ExtraCredits["Service"]) {
	const findAccounts = SqlSchema.findAll({ Request: Schema.Void, Result: NamedRow, execute: () => sql`select id, name, email from users` });
	return Effect.fn("AdminReports.overview")(function* (days: number) {
		const [usageOf, limits, models, accounts, pending, { creditsPerUsd }] = yield* Effect.all(
			[usage(Math.max(days, 2)), limitsToday, creditsByModel(days), findAccounts(undefined).pipe(Effect.catchTags({ SchemaError: Effect.die })), extraCredits.pendingCount, settings.get],
			{ concurrency: "unbounded" },
		);
		const everyone = usageOf.everyone();
		const [yesterday, today] = everyone.slice(-2);
		const outOfCredits = usageOf.users().filter((user) => usageOf.day(user).credits >= limits.limit(user)).length;
		const people = accounts
			.map((account) => ({
				id: account.id,
				name: displayName(account.name, account.email),
				today: { used: usageOf.day(account.id).credits, limit: limits.limit(account.id) },
				...usageOf.total(account.id, days),
			}))
			.sort((a, b) => b.credits - a.credits);
		return {
			today: { active: today.active, replies: today.replies, credits: today.credits, outOfCredits },
			yesterday: { active: yesterday.active, replies: yesterday.replies },
			days: everyone.slice(-days),
			byModel: models,
			people,
			pendingRequests: pending,
			creditsPerUsd,
		};
	});
}

/**
 * Accounts, then invites without an account. Last active is the latest run, or else
 * the latest session.
 */
function makePeopleRows({ sql }: Reads) {
	return SqlSchema.findAll({
		Request: Schema.optional(Schema.String),
		Result: PersonRow,
		execute: (id) => {
			const oneUser = id ? sql`where u.id = ${id} or lower(u.email) = ${id.toLowerCase()}` : sql``;
			const oneInvite = id ? sql`and a.email = ${id.toLowerCase()}` : sql``;
			return sql`
				select u.id, u.name, u.email, u.role, u.banned, u."banReason" as ban_reason, u."banExpires" as ban_expires,
					u."createdAt" as joined_at, a.note, a.created_at as invited_at,
					coalesce(nullif(inviter.name, ''), split_part(inviter.email, '@', 1)) as inviter, null::int as invite_credits,
					coalesce((select max(r.created_at) from runs r where r."user" = u.id),
						(select max(s."updatedAt") from sessions s where s."userId" = u.id)) as last_active
				from users u
				left join allowed_emails a on a.email = lower(u.email)
				left join users inviter on inviter.id = a.invited_by
				${oneUser}
				union all
				select null, null, a.email, null, null, null, null, null, a.note, a.created_at,
					coalesce(nullif(inviter.name, ''), split_part(inviter.email, '@', 1)), a.daily_credits, null
				from allowed_emails a
				left join users inviter on inviter.id = a.invited_by
				where not exists (select 1 from users u where lower(u.email) = a.email) ${oneInvite}`;
		},
	});
}

function makePerson(reads: Reads, peopleRows: ReturnType<typeof makePeopleRows>) {
	const { sql, usage, creditsByModel, limitsToday } = reads;
	const findSessions = SqlSchema.findAll({
		Request: Schema.String,
		Result: SessionRow,
		execute: (userId) => sql`
			select "userAgent" as user_agent, "updatedAt" as updated_at from sessions
			where "userId" = ${userId} and "expiresAt" > now() order by "updatedAt" desc`,
	});
	const countChats = SqlSchema.findOne({
		Request: Schema.String,
		Result: CountRow,
		execute: (userId) => sql`select count(*)::int as count from threads where owner = ${userId}`,
	});

	/** Sessions that have not expired, latest first. */
	const sessionsOf = (userId: string) =>
		Effect.map(findSessions(userId), (rows) => rows.map((row) => ({ device: deviceName(row.user_agent), lastUsed: row.updated_at.toISOString() })));

	return Effect.fn("AdminReports.person")(function* (id: string) {
		const [row] = yield* peopleRows(id).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		if (!row) return Option.none();
		const userId = row.id ?? "";
		const { usageOf, limits, models, sessions, chats } = yield* Effect.all(
			{
				usageOf: usage(30, userId),
				limits: limitsToday,
				models: row.id ? creditsByModel(30, userId) : Effect.succeed([]),
				sessions: row.id ? sessionsOf(userId) : Effect.succeed([]),
				chats: countChats(userId),
			},
			{ concurrency: "unbounded" },
		).pipe(Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die }));
		return Option.some({
			person: toPerson(row, usageOf, limits, new Date(yield* Clock.currentTimeMillis)),
			days: usageOf.series(userId),
			models,
			sessions,
			chats: chats.count,
		});
	});
}

function makeRequests({ usage, limitsToday, namesOf }: Reads, extraCredits: ExtraCredits.ExtraCredits["Service"]) {
	return Effect.gen(function* () {
		const [pending, decided, usageOf, limits] = yield* Effect.all([extraCredits.pending, extraCredits.decided(30), usage(7), limitsToday], { concurrency: "unbounded" });
		const ids = new Set([...pending.map((r) => r.user_id), ...decided.flatMap((r) => [r.user_id, r.decided_by])]);
		const names = yield* namesOf([...ids]);
		const personOf = (id: string) => names.get(id) ?? { id, name: "Removed account", email: "" };
		return {
			pending: pending.map((request) => ({
				id: request.id,
				createdAt: request.created_at.toISOString(),
				person: personOf(request.user_id),
				today: { used: usageOf.day(request.user_id).credits, limit: limits.limit(request.user_id) },
				/** What the approve dialog suggests: the person's usual daily limit. */
				dailyLimit: limits.own(request.user_id) ?? limits.defaultDailyCredits,
				week: usageOf.total(request.user_id, 7).credits,
			})),
			decided: decided.map((request) => ({
				id: request.id,
				createdAt: request.created_at.toISOString(),
				status: request.status,
				credits: request.credits,
				decidedAt: request.decided_at.toISOString(),
				person: personOf(request.user_id),
				decidedBy: personOf(request.decided_by).name,
			})),
		};
	}).pipe(Effect.withSpan("AdminReports.requests"));
}

const make = Effect.gen(function* () {
	const reads = yield* makeReads;
	const { sql, usage, limitsToday, namesOf } = reads;
	const extraCredits = yield* ExtraCredits.ExtraCredits;
	const invites = yield* Invites.Invites;
	const adminEvents = yield* AdminEvents.AdminEvents;
	const peopleRows = makePeopleRows(reads);

	const findAdmins = SqlSchema.findAll({
		Request: Schema.Void,
		Result: NamedRow,
		execute: () => sql`
			select id, name, email from users where 'admin' = any(string_to_array(replace(coalesce(role, ''), ' ', ''), ','))
			order by "createdAt"`,
	});
	const findPerson = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: NamedRow,
		execute: (person) => sql`
			select id, name, email from users where id = ${person} or lower(email) = ${person.toLowerCase()} limit 1`,
	});

	const summary = Effect.all({ pendingRequests: extraCredits.pendingCount, invited: invites.waiting }, { concurrency: "unbounded" }).pipe(
		Effect.withSpan("AdminReports.summary"),
	);

	const people = Effect.gen(function* () {
		const [rows, usageOf, limits] = yield* Effect.all([peopleRows(undefined).pipe(Effect.catchTags({ SchemaError: Effect.die })), usage(7), limitsToday], {
			concurrency: "unbounded",
		});
		const now = new Date(yield* Clock.currentTimeMillis);
		return rows.map((row) => toPerson(row, usageOf, limits, now));
	}).pipe(Effect.withSpan("AdminReports.people"));

	/** The person by user id or email, with both, so the events from before they signed in (their invite) match too. */
	const findFilter = Effect.fnUntraced(function* (person: string) {
		const user = yield* findPerson(person).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		if (Option.isSome(user)) {
			const { id, name, email } = user.value;
			return { ids: [id, email.toLowerCase()], named: { id, name: displayName(name, email), email } };
		}
		// An invite, or someone the log names who has no account now: their events still show.
		return { ids: [person.toLowerCase(), person], named: unknownTarget(person) };
	});

	const activity = Effect.fn("AdminReports.activity")(function* ({ olderThan, person }: { olderThan?: number; person?: string }) {
		const filter = person ? yield* findFilter(person) : null;
		const rows = yield* adminEvents.list({ olderThan, people: filter?.ids, limit: PAGE + 1 });
		const page = rows.slice(0, PAGE);
		const names = yield* namesOf([...new Set(page.flatMap((row) => [row.actor_id, row.target ?? ""]).filter(Boolean))]);
		return {
			events: page.map((row) => toActivity(row, names)),
			next: rows.length > PAGE ? page.at(-1)!.id : null,
			person: filter?.named ?? null,
		} satisfies ActivityPage;
	});

	const admins = findAdmins(undefined).pipe(
		Effect.map((rows) => rows.map((row): Named => ({ id: row.id, name: displayName(row.name, row.email), email: row.email }))),
		Effect.catchTags({ SchemaError: Effect.die }),
		Effect.withSpan("AdminReports.admins"),
	);

	return AdminReports.of({
		summary,
		overview: makeOverview(reads, extraCredits),
		people,
		person: makePerson(reads, peopleRows),
		requests: makeRequests(reads, extraCredits),
		activity,
		admins,
	});
});

export const layer = Layer.effect(AdminReports, make);
