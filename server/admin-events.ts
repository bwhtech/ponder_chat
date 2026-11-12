import { sql } from "./db.ts";

/**
 * The admin activity log: one row in `admin_events` for each change an admin made, from
 * /admin or straight through Better Auth's admin endpoints (admin-auth-events.ts). Only
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

export type EventRow = {
	id: number;
	at: Date;
	actor_id: string;
	actor_email: string;
	action: string;
	target: string | null;
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
};

export async function migrateAdminEvents() {
	await sql`
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
	await sql`create index if not exists admin_events_actor on admin_events (actor_id, id desc)`;
	await sql`create index if not exists admin_events_target on admin_events (target, id desc)`;
}

/**
 * Records one event. The change it describes is already made, so a failed write is
 * logged rather than thrown: failing the request would tell the admin that nothing changed.
 */
export async function recordAdminEvent(event: AdminEvent) {
	try {
		await sql`
			insert into admin_events (actor_id, actor_email, action, target, before, after)
			values (${event.actor.id}, ${event.actor.email}, ${event.action}, ${event.target ?? null},
				${event.before ? sql.json(event.before as never) : null}, ${event.after ? sql.json(event.after as never) : null})`;
	} catch (error) {
		console.error(`admin-events: could not record ${event.action} by ${event.actor.email}:`, error instanceof Error ? error.message : error);
	}
}

/**
 * Events newest first, `limit` at a time. `olderThan` is the last id of the page before.
 * `people` limits them to events done by, or to, any of these ids or emails.
 */
export async function listAdminEvents({ olderThan, people, limit }: { olderThan?: number; people?: string[]; limit: number }) {
	const older = olderThan ? sql`and id < ${olderThan}` : sql``;
	const about = people?.length ? sql`and (actor_id in ${sql(people)} or target in ${sql(people)})` : sql``;
	return sql<EventRow[]>`
		select id, at, actor_id, actor_email, action, target, before, after from admin_events
		where true ${older} ${about}
		order by id desc limit ${limit}`;
}
