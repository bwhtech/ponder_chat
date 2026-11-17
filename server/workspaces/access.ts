/**
 * Who can do what in a workspace (docs/workspaces-plan.md, "Database"). Pure, so the
 * table is in one place and its cells can be tested without a database. Workspaces.ts
 * reads the rows and asks these functions.
 *
 * | Workspace     | Owner   | Member          | Admin              | Anyone else |
 * | ------------- | ------- | --------------- | ------------------ | ----------- |
 * | Organisation  | owner   | —               | edit               | ask         |
 * | Private       | owner   | ask or edit     | none, unless added | none        |
 */
export type Kind = "org" | "private";
export type MemberAccess = "ask" | "edit";
export type Access = "none" | MemberAccess | "owner";

/** What access is decided from: the workspace, and the person's member row in it, if any. */
export type AccessFacts = { kind: Kind; ownerId: string; member: MemberAccess | null };

const RANK: Record<Access, number> = { none: 0, ask: 1, edit: 2, owner: 3 };

/** The person's access to a workspace that is not deleted. */
export function accessFrom(facts: AccessFacts, userId: string, admin: boolean): Access {
	if (facts.ownerId === userId) return "owner";
	// An organisation workspace has no members: everyone asks, and admins edit.
	if (facts.kind === "org") return admin ? "edit" : "ask";
	// An admin is no one special in a private workspace: chats and documents there are the owner's to share.
	return facts.member ?? "none";
}

export function atLeast(access: Access, needed: Access) {
	return RANK[access] >= RANK[needed];
}

/**
 * Who changes the sharing of a workspace, and deletes it: the owner of a private one, an
 * admin for an organisation one. An owner of an organisation workspace who is no longer an
 * admin can still edit it, but not share or delete it.
 */
export function canManage(kind: Kind, access: Access, admin: boolean) {
	return kind === "org" ? admin : access === "owner";
}
