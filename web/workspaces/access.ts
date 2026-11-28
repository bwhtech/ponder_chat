import { count } from "../numbers";

/** Who can change and share a workspace, who can use it, and how many: no state here, so a test can import them. store.ts hands them on. */
export function canEdit(workspace: { access: string }) {
	return workspace.access === "edit" || workspace.access === "owner";
}

/** Who adds people, changes their roles and removes them: everyone who can edit (server/workspaces/access.ts). */
export function canShare(workspace: { access: string }) {
	return canEdit(workspace);
}

/** Who it is shared with: the people added, and the active teams added. */
type Sharing = { orgAccess: string; memberCount: number; teamCount: number };

/** Someone besides the owner can use it: it is open to everyone, or someone or a team was added. */
export function isShared(workspace: Sharing) {
	return workspace.orgAccess !== "none" || workspace.memberCount > 0 || workspace.teamCount > 0;
}

/** Who can use it, as an icon: a building while open to everyone, people once someone or a team is added, else a lock. */
export function accessIcon(workspace: Sharing) {
	if (workspace.orgAccess !== "none") return "lucide-building-2";
	return workspace.memberCount || workspace.teamCount ? "lucide-users" : "lucide-lock";
}

/** Who can use it, in a few words: the sidebar row's hint. */
export function sharedWith(workspace: Sharing & { access: string }) {
	if (workspace.orgAccess !== "none") return "Everyone";
	if (workspace.access !== "owner") return "Shared with you";
	const others = [workspace.memberCount ? people(workspace.memberCount) : "", workspace.teamCount ? teams(workspace.teamCount) : ""].filter(Boolean);
	if (others.length === 2) return `You, ${others[0]} and ${others[1]}`;
	return others.length ? `You and ${others[0]}` : "Only you";
}

export function people(total: number) {
	return `${count(total)} ${total === 1 ? "person" : "people"}`;
}

function teams(total: number) {
	return `${count(total)} ${total === 1 ? "team" : "teams"}`;
}
