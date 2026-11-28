/**
 * Who can manage a team (docs/teams-plan.md, "Access"). Pure, so the table is in one place
 * and its cells can be tested without a database. Teams.ts reads the rows and asks these
 * functions.
 *
 * | Action                                          | Org admin     | Team admin              | Member | Anyone else |
 * | ----------------------------------------------- | ------------- | ----------------------- | ------ | ----------- |
 * | See the members and invites in /admin           | yes           | yes                     | no     | no          |
 * | Add, remove, change role, invite, cancel invite | yes           | yes, not the last admin | no     | no          |
 * | Make, rename, archive, restore                  | yes           | no                      | no     | no          |
 * | Delete                                          | yes, archived | no                      | no     | no          |
 *
 * Nobody changes the people of an archived team.
 */
export type TeamRole = "member" | "admin";

/** The person who asks: whether they are an org admin, and their role in this team, if any. */
export type TeamViewer = { orgAdmin: boolean; role: TeamRole | null };

/** Sees the team's members and invites, in /admin. */
export function canAdminister(viewer: TeamViewer) {
	return viewer.orgAdmin || viewer.role === "admin";
}

/** Adds, removes and changes the roles of its people, and its invites. */
export function canChangePeople(viewer: TeamViewer, archived: boolean) {
	return !archived && canAdminister(viewer);
}

/** Makes, renames, archives and restores teams. */
export function canOrganise(viewer: TeamViewer) {
	return viewer.orgAdmin;
}

export function canDelete(viewer: TeamViewer, archived: boolean) {
	return archived && viewer.orgAdmin;
}

/**
 * A change of one person's role: `from` their role now (null: not in the team), `to` after
 * it (null: removed). True when a team admin would leave the team with no admin. An org
 * admin may do that: the team then has only org admins to manage it.
 */
export function leavesNoAdmin(viewer: TeamViewer, team: { admins: number }, change: { from: TeamRole | null; to: TeamRole | null }) {
	if (viewer.orgAdmin) return false;
	return change.from === "admin" && change.to !== "admin" && team.admins <= 1;
}
