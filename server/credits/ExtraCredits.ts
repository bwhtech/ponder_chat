import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

/**
 * Extra credits. A person who has used today's credits can ask the admins for more
 * (POST /api/credits/request). An admin approves with a number of credits, or declines
 * (/admin, Requests). An admin can also give credits without a request. A grant adds to
 * the limit of one UTC day only: the next day starts on the usual limit again.
 *
 * A person has at most one pending request at a time. After an answer they can ask again.
 * A request that is still pending at midnight UTC stays pending, and an approval gives
 * credits for the day of the approval.
 */
export type RequestStatus = "pending" | "approved" | "declined";
export type CreditRequest = { status: RequestStatus; createdAt: string; credits: number | null };
export type Decision = { status: "approved"; credits: number } | { status: "declined" };

// The columns as they come back: integer and ::int are numbers, timestamptz a Date.
const CreditsRow = Schema.Struct({ credits: Schema.Number });
const CountRow = Schema.Struct({ count: Schema.Number });
const IdRow = Schema.Struct({ id: Schema.Number });
const UserRow = Schema.Struct({ user_id: Schema.String });
const CurrentRow = Schema.Struct({
	status: Schema.Literals(["pending", "approved", "declined"]),
	created_at: Schema.Date,
	credits: Schema.NullOr(Schema.Number),
});
const PendingRow = Schema.Struct({ id: Schema.Number, user_id: Schema.String, created_at: Schema.Date });
const DecidedRow = Schema.Struct({
	id: Schema.Number,
	user_id: Schema.String,
	created_at: Schema.Date,
	status: Schema.Literals(["approved", "declined"]),
	credits: Schema.NullOr(Schema.Number),
	decided_by: Schema.String,
	decided_at: Schema.Date,
});
const UserDay = Schema.Struct({ user: Schema.String, day: Schema.String });
const UserSince = Schema.Struct({ user: Schema.String, since: Schema.Date });

export type PendingRequest = typeof PendingRow.Type;
export type DecidedRequest = typeof DecidedRow.Type;

export class ExtraCredits extends Context.Service<
	ExtraCredits,
	{
		/** Creates the requests and grants tables and their indexes. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** Extra credits a person got for one UTC day ("2026-11-05"). */
		readonly extraCredits: (user: string, day: string) => Effect.Effect<number, SqlError>;
		/** What the chat page shows: the pending request, or the latest one answered since `since`. */
		readonly currentRequest: (user: string, since: Date) => Effect.Effect<CreditRequest | null, SqlError>;
		/** A new request's id, or none when one is already waiting. */
		readonly ask: (user: string) => Effect.Effect<Option.Option<number>, SqlError>;
		/** Answers a pending request. The person's id, or none when it was answered already. */
		readonly decide: (id: number, decision: Decision, by: string) => Effect.Effect<Option.Option<string>, SqlError>;
		/** Extra credits for today without a request. */
		readonly grant: (user: string, credits: number, by: string) => Effect.Effect<void, SqlError>;
		/** The requests waiting for an answer, oldest first. */
		readonly pending: Effect.Effect<ReadonlyArray<PendingRequest>, SqlError>;
		/** The requests answered in the last `days` days, newest first. */
		readonly decided: (days: number) => Effect.Effect<ReadonlyArray<DecidedRequest>, SqlError>;
		readonly pendingCount: Effect.Effect<number, SqlError>;
	}
>()("ponder/credits/ExtraCredits") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists credit_requests (
				id integer primary key generated always as identity,
				user_id text not null,
				created_at timestamptz not null default now(),
				status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
				decided_by text,
				decided_at timestamptz,
				credits integer
			)`;
		yield* sql`create unique index if not exists credit_requests_one_pending on credit_requests (user_id) where status = 'pending'`;
		yield* sql`create index if not exists credit_requests_user on credit_requests (user_id, created_at desc)`;
		// The answered requests on /admin, Requests, newest first.
		yield* sql`create index if not exists credit_requests_decided on credit_requests (decided_at desc) where status <> 'pending'`;
		yield* sql`
			create table if not exists credit_grants (
				id integer primary key generated always as identity,
				user_id text not null,
				day date not null,
				credits integer not null check (credits > 0),
				granted_by text not null,
				request_id integer,
				created_at timestamptz not null default now()
			)`;
		yield* sql`create index if not exists credit_grants_user_day on credit_grants (user_id, day)`;
		// Everyone's grants for one day: the limits on /admin and in deploy/sentinel.sh.
		yield* sql`create index if not exists credit_grants_day on credit_grants (day)`;
	});

	const findExtra = SqlSchema.findOne({
		Request: UserDay,
		Result: CreditsRow,
		execute: ({ user, day }) => sql`
			select coalesce(sum(credits), 0)::int as credits from credit_grants where user_id = ${user} and day = ${day}`,
	});
	const findCurrent = SqlSchema.findOneOption({
		Request: UserSince,
		Result: CurrentRow,
		execute: ({ user, since }) => sql`
			select status, created_at, credits from credit_requests
			where user_id = ${user} and (status = 'pending' or decided_at >= ${since})
			order by created_at desc limit 1`,
	});
	const insertRequest = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: IdRow,
		execute: (user) => sql`
			insert into credit_requests (user_id) values (${user})
			on conflict (user_id) where status = 'pending' do nothing
			returning id`,
	});
	const findPending = SqlSchema.findAll({
		Request: Schema.Void,
		Result: PendingRow,
		execute: () => sql`select id, user_id, created_at from credit_requests where status = 'pending' order by created_at`,
	});
	const findDecided = SqlSchema.findAll({
		Request: Schema.Number,
		Result: DecidedRow,
		execute: (days) => sql`
			select id, user_id, created_at, status, credits, decided_by, decided_at from credit_requests
			where status <> 'pending' and decided_at > now() - make_interval(days => ${days})
			order by decided_at desc`,
	});
	const countPending = SqlSchema.findOne({
		Request: Schema.Void,
		Result: CountRow,
		execute: () => sql`select count(*)::int as count from credit_requests where status = 'pending'`,
	});

	// A row that does not decode, or an aggregate with no row, is not Ponder's database: a defect.
	const extraCredits = Effect.fn("ExtraCredits.extraCredits")(function* (user: string, day: string) {
		const row = yield* findExtra({ user, day }).pipe(Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die }));
		return row.credits;
	});

	const currentRequest = Effect.fn("ExtraCredits.currentRequest")(function* (user: string, since: Date) {
		const row = yield* findCurrent({ user, since }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.match(row, {
			onNone: (): CreditRequest | null => null,
			onSome: (found) => ({ status: found.status, createdAt: found.created_at.toISOString(), credits: found.credits }),
		});
	});

	const ask = Effect.fn("ExtraCredits.ask")(function* (user: string) {
		const row = yield* insertRequest(user).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.map(row, (found) => found.id);
	});

	const decide = Effect.fn("ExtraCredits.decide")(function* (id: number, decision: Decision, by: string) {
		const credits = decision.status === "approved" ? decision.credits : null;
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const [request] = yield* sql<{ user_id: string }>`
					update credit_requests set status = ${decision.status}, credits = ${credits}, decided_by = ${by}, decided_at = now()
					where id = ${id} and status = 'pending'
					returning user_id`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(UserRow))), Effect.catchTags({ SchemaError: Effect.die }));
				if (!request) return Option.none<string>();
				if (credits) {
					yield* sql`
						insert into credit_grants (user_id, day, credits, granted_by, request_id)
						values (${request.user_id}, (now() at time zone 'utc')::date, ${credits}, ${by}, ${id})`;
				}
				return Option.some(request.user_id);
			}),
		);
	});

	const grant = Effect.fn("ExtraCredits.grant")(function* (user: string, credits: number, by: string) {
		yield* sql`
			insert into credit_grants (user_id, day, credits, granted_by)
			values (${user}, (now() at time zone 'utc')::date, ${credits}, ${by})`;
	});

	const pending = findPending(undefined).pipe(Effect.catchTags({ SchemaError: Effect.die }), Effect.withSpan("ExtraCredits.pending"));

	const decided = Effect.fn("ExtraCredits.decided")(function* (days: number) {
		return yield* findDecided(days).pipe(Effect.catchTags({ SchemaError: Effect.die }));
	});

	const pendingCount = countPending(undefined).pipe(
		Effect.map((row) => row.count),
		Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die }),
		Effect.withSpan("ExtraCredits.pendingCount"),
	);

	return ExtraCredits.of({ migrate, extraCredits, currentRequest, ask, decide, grant, pending, decided, pendingCount });
});

export const layer = Layer.effect(ExtraCredits, make);
