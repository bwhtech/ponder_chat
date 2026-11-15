import type { EventRow } from "./AdminEvents.ts";
import { displayName } from "./people.ts";

/**
 * The Activity page of /admin: the admin activity log (AdminEvents.ts), a page at a
 * time, with each admin and person named as they are now. An admin who has left keeps
 * the email they had then. An invite without an account is named by its email.
 *
 * Plain code: AdminReports.ts reads the rows.
 */
export const PAGE = 50;

export type Named = { id: string; name: string; email: string };

/**
 * One change an admin made. `action` is the endpoint's name, such as "update-user" or
 * "grant-credits"; `before` and `after` hold what changed. `target` is the person it was
 * done to, if any.
 */
export type Activity = {
	id: number;
	at: string;
	actor: Named;
	action: string;
	target: Named | null;
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
};

export function toActivity(row: EventRow, names: Map<string, Named>): Activity {
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

export function unknownTarget(target: string): Named {
	return target.includes("@") ? { id: target, name: displayName(null, target), email: target } : { id: target, name: "Unknown person", email: "" };
}
