import { computed, ref } from "vue";
import { me } from "../account";
import { client, unwrap, type Answer } from "../api";
import { fromBoot } from "../boot";
import { count } from "../numbers";

/**
 * The workspaces the person can use (server/workspaces/), for the sidebar, the composer's
 * workspace chip and the workspace page. The first list comes with the page (boot.ts);
 * later ones ask the API. Organisation workspaces come first, then the ones shared with the
 * person, then their own, as the server orders them.
 *
 * The open workspace lives in the URL (`?w=<id>`), as the open chat does (`?t=<id>`).
 */
export type WorkspaceSummary = Answer<typeof client.api.workspaces.$get>["workspaces"][number];
export type WorkspaceDetail = Answer<(typeof client.api.workspaces)[":id"]["$get"]>["workspace"];
/** A person in the people picker, and a member: written out, so the check without the server (tsconfig.no-node.json) still knows them. */
export type Person = { id: string; name: string; email: string };
export type MemberAccess = "ask" | "edit";
export type Member = Person & { access: MemberAccess };
export type WorkspaceInput = { kind?: "org" | "private"; name: string; description: string; instructions: string };

export const workspaces = ref<WorkspaceSummary[]>([]);
/** The list came from the server: until then the sidebar shows skeleton rows. */
export const workspacesLoaded = ref(false);
/** The workspace open in the main area, from `?w=<id>`; empty when a chat or Memory is open. */
export const openWorkspaceId = ref(workspaceInUrl());

export const isAdmin = computed(() => me.value?.user.role === "admin");

export function workspaceById(id: string | null | undefined) {
	return id ? workspaces.value.find((workspace) => workspace.id === id) : undefined;
}

export async function loadWorkspaces() {
	try {
		const fresh = fromBoot("workspaces") ?? (await unwrap(client.api.workspaces.$get())).workspaces;
		workspaces.value = fresh;
		workspacesLoaded.value = true;
	} catch {
		// Offline: keep the list the page has. The rows stay skeletons until one load works.
	}
}

export function workspaceInUrl() {
	return new URL(location.href).searchParams.get("w") ?? "";
}

/** Opens the workspace page: `?w=<id>`, in place of the open chat or Memory. */
export function showWorkspace(id: string) {
	openWorkspaceId.value = id;
	const url = new URL(location.href);
	for (const key of ["t", "view"]) url.searchParams.delete(key);
	url.searchParams.set("w", id);
	if (url.href !== location.href) history.pushState(null, "", url);
}

export async function fetchWorkspace(id: string): Promise<WorkspaceDetail> {
	return (await unwrap(client.api.workspaces[":id"].$get({ param: { id: encodeURIComponent(id) } }), "The workspace could not load.")).workspace;
}

export async function createWorkspace(input: WorkspaceInput) {
	const { workspace } = await unwrap(client.api.workspaces.$post({ json: { ...input, icon: null } }), "The workspace could not be made.");
	await loadWorkspaces();
	return workspace;
}

export async function updateWorkspace(id: string, changes: Omit<WorkspaceInput, "kind">) {
	const { workspace } = await unwrap(client.api.workspaces[":id"].$patch({ param: { id: encodeURIComponent(id) }, json: changes }), "The workspace could not be saved.");
	await loadWorkspaces();
	return workspace;
}

export async function shareWorkspace(id: string, kind: "org" | "private", members: { userId: string; access: MemberAccess }[]) {
	const json = { kind, members };
	const { workspace } = await unwrap(client.api.workspaces[":id"].sharing.$put({ param: { id: encodeURIComponent(id) }, json }), "Sharing could not be saved.");
	await loadWorkspaces();
	return workspace;
}

export async function deleteWorkspace(id: string) {
	await unwrap(client.api.workspaces[":id"].$delete({ param: { id: encodeURIComponent(id) } }), "The workspace could not be deleted.");
	await loadWorkspaces();
}

export async function searchPeople(q: string): Promise<readonly Person[]> {
	return (await unwrap(client.api.people.$get({ query: { q } }), "People could not load.")).people;
}

/** The icon of a workspace's kind: a building for everyone, people when shared, a lock when only the owner uses it. */
export function kindIcon(workspace: Pick<WorkspaceSummary, "kind" | "memberCount">) {
	if (workspace.kind === "org") return "lucide-building-2";
	return workspace.memberCount ? "lucide-users" : "lucide-lock";
}

/** Who can use it, in a few words: for the badge on the workspace page and the sidebar row's hint. */
export function sharedWith(workspace: Pick<WorkspaceSummary, "kind" | "access" | "memberCount">) {
	if (workspace.kind === "org") return "Everyone";
	if (workspace.access !== "owner") return "Shared with you";
	return workspace.memberCount ? `You and ${people(workspace.memberCount)}` : "Only you";
}

/** The owner shares a private workspace; an admin an organisation one (server/workspaces/access.ts). */
export function canShare(workspace: Pick<WorkspaceSummary, "kind" | "access">) {
	return workspace.kind === "org" ? isAdmin.value : workspace.access === "owner";
}

export function canEdit(workspace: Pick<WorkspaceSummary, "access">) {
	return workspace.access === "edit" || workspace.access === "owner";
}

export function people(total: number) {
	return `${count(total)} ${total === 1 ? "person" : "people"}`;
}
