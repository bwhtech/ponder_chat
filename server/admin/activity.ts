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

/**
 * `workspaces` names the organisation workspaces that sharing events point to: those
 * events keep the workspace's id only.
 */
export function toActivity(row: EventRow, names: Map<string, Named>, workspaces = new Map<string, string>()): Activity {
	const { before, after } = WORKSPACE_ACTIONS.has(row.action) ? workspaceChanges(row, workspaces) : row;
	return {
		id: row.id,
		at: row.at.toISOString(),
		actor: names.get(row.actor_id) ?? { id: row.actor_id, name: displayName(null, row.actor_email), email: row.actor_email },
		action: row.action,
		target: row.target ? (names.get(row.target) ?? unknownTarget(row.target)) : null,
		before,
		after,
	};
}

/** The events of organisation workspaces (workspaces/Workspaces.ts). */
export const WORKSPACE_ACTIONS = new Set(["create-workspace", "update-workspace", "share-workspace", "delete-workspace"]);

/** The workspace ids that sharing events point to, to name them. */
export function sharedWorkspaceIds(rows: ReadonlyArray<EventRow>) {
	return [...new Set(rows.flatMap((row) => (row.action === "share-workspace" && typeof row.after?.workspace === "string" ? [row.after.workspace] : [])))];
}

/**
 * A workspace's instructions can be 20,000 characters, twice in an update: the page gets
 * their length, and whether they changed, not the text. A sharing event gets the
 * workspace's name while it is for everyone.
 */
function workspaceChanges(row: EventRow, workspaces: Map<string, string>) {
	const before = row.before && withoutInstructions(row.before);
	const after = row.after && withoutInstructions(row.after, row.before);
	const name = after && row.action === "share-workspace" ? workspaces.get(String(after.workspace)) : undefined;
	return { before, after: after && name ? { ...after, name } : after };
}

function withoutInstructions(fields: Record<string, unknown>, before?: Record<string, unknown> | null) {
	if (typeof fields.instructions !== "string") return fields;
	const { instructions, ...rest } = fields;
	const changed = typeof before?.instructions === "string" ? { instructionsChanged: before.instructions !== instructions } : {};
	return { ...rest, instructionsLength: instructions.length, ...changed };
}

export function unknownTarget(target: string): Named {
	return target.includes("@") ? { id: target, name: displayName(null, target), email: target } : { id: target, name: "Unknown person", email: "" };
}
