import { listAdminEvents, type EventRow } from "../admin-events.ts";
import { sql } from "../db.ts";
import { displayName, namesOf } from "./people.ts";

/**
 * The Activity page of /admin: the admin activity log (admin-events.ts), a page at a
 * time, with each admin and person named as they are now. An admin who has left keeps
 * the email they had then. An invite without an account is named by its email.
 */
const PAGE = 50;

type Named = { id: string; name: string; email: string };

export type Activity = {
	id: number;
	at: string;
	actor: Named;
	action: string;
	target: Named | null;
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
};

/**
 * `person` keeps the events done by or to one person. `next` is the `olderThan` for the
 * page after, or null on the last page.
 */
export async function activityPage({ olderThan, person }: { olderThan?: number; person?: string }) {
	const filter = person ? await findPerson(person) : null;
	const rows = await listAdminEvents({ olderThan, people: filter?.ids, limit: PAGE + 1 });
	const page = rows.slice(0, PAGE);
	const names = await namesOf([...new Set(page.flatMap((row) => [row.actor_id, row.target ?? ""]).filter(Boolean))]);
	return {
		events: page.map((row) => toActivity(row, names)),
		next: rows.length > PAGE ? page.at(-1)!.id : null,
		person: filter?.named ?? null,
	};
}

/** The person by user id or email, with both, so the events from before they signed in (their invite) match too. */
async function findPerson(person: string) {
	const [user] = await sql<{ id: string; name: string; email: string }[]>`
		select id, name, email from users where id = ${person} or lower(email) = ${person.toLowerCase()} limit 1`;
	if (user) return { ids: [user.id, user.email.toLowerCase()], named: { id: user.id, name: displayName(user.name, user.email), email: user.email } };
	// An invite, or someone the log names who has no account now: their events still show.
	return { ids: [person.toLowerCase(), person], named: unknownTarget(person) };
}

function toActivity(row: EventRow, names: Map<string, Named>): Activity {
	return {
		id: row.id,
		at: row.at.toISOString(),
		actor: names.get(row.actor_id) ?? { id: row.actor_id, name: displayName(null, row.actor_email), email: row.actor_email },
		action: row.action,
		target: row.target ? (names.get(row.target) ?? unknownTarget(row.target)) : null,
		before: row.before,
		after: row.after,
	};
}

function unknownTarget(target: string): Named {
	return target.includes("@") ? { id: target, name: displayName(null, target), email: target } : { id: target, name: "Unknown person", email: "" };
}
