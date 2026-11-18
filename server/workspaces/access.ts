/**
 * Who can do what in a workspace (docs/workspaces-plan.md, "Database"). Pure, so the
 * table is in one place and its cells can be tested without a database. Workspaces.ts
 * reads the rows and asks these functions.
 *
 * A workspace has people, each added with their own role, and a General access setting
 * (`org_access`) that opens it to everyone in the organisation. A person's access is the
 * higher of their own role and the one General access gives them.
 *
 * | General access                  | Owner | Member      | Admin, not a member | Anyone else |
 * | ------------------------------- | ----- | ----------- | ------------------- | ----------- |
 * | Only people added (`none`)      | owner | ask or edit | none                | none        |
 * | Everyone in the organisation    | owner | ask or edit | edit                | ask         |
 */
export type OrgAccess = "none" | "ask";
export type MemberAccess = "ask" | "edit";
export type Access = "none" | MemberAccess | "owner";

/** What access is decided from: the workspace, and the person's member row in it, if any. */
export type AccessFacts = { orgAccess: OrgAccess; ownerId: string; member: MemberAccess | null };

const RANK: Record<Access, number> = { none: 0, ask: 1, edit: 2, owner: 3 };

/** The person's access to a workspace that is not deleted. */
export function accessFrom(facts: AccessFacts, userId: string, admin: boolean): Access {
	if (facts.ownerId === userId) return "owner";
	const own: Access = facts.member ?? "none";
	// An admin is no one special in a private workspace: chats and documents there are the owner's to share.
	if (facts.orgAccess === "none") return own;
	// Open to everyone: it is organisation content, which admins edit.
	return highest(own, admin ? "edit" : facts.orgAccess);
}

export function atLeast(access: Access, needed: Access) {
	return RANK[access] >= RANK[needed];
}

function highest(a: Access, b: Access) {
	return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Who adds people, changes their roles and removes them: everyone who can edit. That is the
 * owner, members with Can edit, and admins while the workspace is open to everyone. Nobody
 * changes or removes the owner.
 */
export function canShare(access: Access) {
	return atLeast(access, "edit");
}

/** Who deletes it: its owner, and admins while it is open to everyone. */
export function canDelete(orgAccess: OrgAccess, access: Access, admin: boolean) {
	return access === "owner" || (orgAccess !== "none" && admin);
}

/**
 * Who opens it to everyone, or closes it: an admin who owns it, or any admin while it is open.
 * An admin added to someone's private workspace cannot open it.
 */
export function canChangeOrgAccess(orgAccess: OrgAccess, access: Access, admin: boolean) {
	return admin && canDelete(orgAccess, access, admin);
}
