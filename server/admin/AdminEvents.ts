import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { sqlMessage } from "../runtime/Database.ts";

/**
 * The admin activity log: one row in `admin_events` for each change an admin made, from
 * /admin or straight through Better Auth's admin endpoints (auth/AdminAuthEvents.ts). Only
 * the server writes it, and nothing updates or deletes a row. /admin shows it on the
 * Activity page.
 *
 * `target` is a user id, or an email for an invite. Events about something other than a
 * person (settings, skills) have no target. `before` and `after` hold what changed, never
 * a secret: the OpenRouter key's event says only that it changed.
 */
export type AdminEvent = {
	actor: { id: string; email: string };
	action: string;
	target?: string | null;
	before?: Record<string, unknown> | null;
	after?: Record<string, unknown> | null;
};

/** The changes in a row: jsonb, parsed. */
const Changes = Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown));

const EventRow = Schema.Struct({
	id: Schema.Number,
	at: Schema.Date,
	actor_id: Schema.String,
	actor_email: Schema.String,
	action: Schema.String,
	target: Schema.NullOr(Schema.String),
	before: Changes,
	after: Changes,
});

export type EventRow = typeof EventRow.Type;

/** A page of events: `olderThan` is the last id of the page before; `people` the ids or emails of people they were done by or to. */
export type EventQuery = { olderThan?: number; people?: ReadonlyArray<string>; limit: number };

const Query = Schema.Struct({
	olderThan: Schema.optional(Schema.Number),
	people: Schema.optional(Schema.Array(Schema.String)),
	limit: Schema.Number,
});

export class AdminEvents extends Context.Service<
	AdminEvents,
	{
		/** Creates the table and its indexes. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/**
		 * Records one event. The change it describes is already made, so a failed write is
		 * logged rather than returned: failing the request would tell the admin that nothing changed.
		 */
		readonly record: (event: AdminEvent) => Effect.Effect<void>;
		/** Events newest first, `limit` at a time. `people` limits them to events done by, or to, any of these ids or emails. */
		readonly list: (query: EventQuery) => Effect.Effect<ReadonlyArray<EventRow>, SqlError>;
	}
>()("ponder/admin/AdminEvents") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists admin_events (
				id integer primary key generated always as identity,
				at timestamptz not null default now(),
				actor_id text not null,
				actor_email text not null,
				action text not null,
				target text,
				before jsonb,
				after jsonb
			)`;
		// Filtering by person matches either side of an event.
		yield* sql`create index if not exists admin_events_actor on admin_events (actor_id, id desc)`;
		yield* sql`create index if not exists admin_events_target on admin_events (target, id desc)`;
	});

	const findEvents = SqlSchema.findAll({
		Request: Query,
		Result: EventRow,
		execute: ({ olderThan, people, limit }) => {
			const older = olderThan ? sql`and id < ${olderThan}` : sql``;
			const about = people?.length ? sql`and (actor_id in ${sql.in(people)} or target in ${sql.in(people)})` : sql``;
			return sql`
				select id, at, actor_id, actor_email, action, target, before, after from admin_events
				where true ${older} ${about}
				order by id desc limit ${limit}`;
		},
	});

	const record = Effect.fn("AdminEvents.record")(function* (event: AdminEvent) {
		const failed = `admin-events: could not record ${event.action} by ${event.actor.email}:`;
		yield* sql`
			insert into admin_events (actor_id, actor_email, action, target, before, after)
			values (${event.actor.id}, ${event.actor.email}, ${event.action}, ${event.target ?? null},
				${event.before ? sql.json(event.before) : null}, ${event.after ? sql.json(event.after) : null})`.pipe(
			Effect.catchTags({ SqlError: (error) => Effect.logError(failed, sqlMessage(error)) }),
			// Such as a value that JSON can't hold: logged as any failure was.
			Effect.catchDefect((defect) => Effect.logError(failed, defect instanceof Error ? defect.message : defect)),
		);
	});

	const list = Effect.fn("AdminEvents.list")(function* (query: EventQuery) {
		return yield* findEvents(query).pipe(Effect.catchTags({ SchemaError: Effect.die }));
	});

	return AdminEvents.of({ migrate, record, list });
});

export const layer = Layer.effect(AdminEvents, make);
