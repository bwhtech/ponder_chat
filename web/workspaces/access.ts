import { count } from "../numbers";

/** Who can change and share a workspace, who can use it, and how many: no state here, so a test can import them. store.ts hands them on. */
export function canEdit(workspace: { access: string }) {
	return workspace.access === "edit" || workspace.access === "owner";
}

/** Who adds people, changes their roles and removes them: everyone who can edit (server/workspaces/access.ts). */
export function canShare(workspace: { access: string }) {
	return canEdit(workspace);
}

/** Someone besides the owner can use it: it is open to everyone, or someone was added. */
export function isShared(workspace: { orgAccess: string; memberCount: number }) {
	return workspace.orgAccess !== "none" || workspace.memberCount > 0;
}

/** Who can use it, as an icon: a building while open to everyone, people once someone is added, else a lock. */
export function accessIcon(workspace: { orgAccess: string; memberCount: number }) {
	if (workspace.orgAccess !== "none") return "lucide-building-2";
	return workspace.memberCount ? "lucide-users" : "lucide-lock";
}

/** Who can use it, in a few words: the sidebar row's hint. */
export function sharedWith(workspace: { orgAccess: string; access: string; memberCount: number }) {
	if (workspace.orgAccess !== "none") return "Everyone";
	if (workspace.access !== "owner") return "Shared with you";
	return workspace.memberCount ? `You and ${people(workspace.memberCount)}` : "Only you";
}

export function people(total: number) {
	return `${count(total)} ${total === 1 ? "person" : "people"}`;
}
