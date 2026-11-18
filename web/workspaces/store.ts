import { computed, ref } from "vue";
import { me } from "../account";
import { client, unwrap, type Answer } from "../api";
import { fromBoot } from "../boot";
import { toast } from "../toasts";
import { canEdit, people } from "./access";

/**
 * The workspaces the person can use (server/workspaces/), for the sidebar, the composer's
 * workspace chip and the workspace page. The first list comes with the page (boot.ts);
 * later ones ask the API. The ones the person pinned come first, then the newest made first,
 * as the server orders them (server/workspaces/rows.ts); a pin here sorts the same way at once.
 *
 * The open workspace lives in the URL by its slug (`?w=hr-policies`), as the open chat does
 * by its id (`?t=<id>`). Links from before slugs have its id there: the page opens them and
 * puts the slug in their place.
 */
export type WorkspaceSummary = Answer<typeof client.api.workspaces.$get>["workspaces"][number];
export type WorkspaceDetail = Answer<(typeof client.api.workspaces)[":id"]["$get"]>["workspace"];
/** A person in the people picker, and a member. */
export type Person = { id: string; name: string; email: string };
export type MemberAccess = "ask" | "edit";
export type Member = Person & { access: MemberAccess };
export type WorkspaceInput = { kind?: "org" | "private"; name: string; instructions: string };

export const workspaces = ref<WorkspaceSummary[]>([]);
/** The list came from the server: until then the sidebar shows skeleton rows. */
export const workspacesLoaded = ref(false);
/** The workspace open in the main area, from `?w=`: its slug, or its id in an older link. Empty when a chat is open. */
export const openWorkspaceKey = ref(workspaceInUrl());
export const openWorkspace = computed(() => workspaceByKey(openWorkspaceKey.value));

export const isAdmin = computed(() => me.value?.user.role === "admin");

export function workspaceById(id: string | null | undefined) {
	return id ? workspaces.value.find((workspace) => workspace.id === id) : undefined;
}

/** By the `?w=` of the URL: a slug, or an id. */
export function workspaceByKey(key: string | null | undefined) {
	return key ? workspaces.value.find((workspace) => workspace.slug === key || workspace.id === key) : undefined;
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

/** Opens the workspace page: `?w=<slug>`, in place of the open chat. */
export function showWorkspace(slug: string) {
	openWorkspaceKey.value = slug;
	const url = new URL(location.href);
	url.searchParams.delete("t");
	url.searchParams.set("w", slug);
	if (url.href !== location.href) history.pushState(null, "", url);
}

/** A workspace page's address, for a link to it. */
export function workspaceHref(slug: string) {
	return `/?w=${encodeURIComponent(slug)}`;
}

/**
 * An older link opened by the workspace's id: its slug takes the id's place, in the same
 * history entry. Only while that page is still the open one.
 */
export function replaceWorkspaceKey(opened: string, slug: string) {
	if (openWorkspaceKey.value !== opened || opened === slug) return;
	openWorkspaceKey.value = slug;
	const url = new URL(location.href);
	url.searchParams.set("w", slug);
	history.replaceState(history.state, "", url);
}

/** By its id or its slug (server/workspaces/slug.ts). */
export async function fetchWorkspace(idOrSlug: string): Promise<WorkspaceDetail> {
	return (await unwrap(client.api.workspaces[":id"].$get({ param: { id: encodeURIComponent(idOrSlug) } }), "The workspace could not load.")).workspace;
}

/**
 * A workspace made in this tab, by its slug, until its page takes it: the page shows it at once,
 * with no chats, and asks the server for it meanwhile (WorkspacePage.vue).
 */
const madeHere = new Map<string, WorkspaceDetail>();

export async function createWorkspace(input: WorkspaceInput) {
	const { workspace } = await unwrap(client.api.workspaces.$post({ json: { ...input, icon: null } }), "The workspace could not be made.");
	madeHere.set(workspace.slug, workspace);
	await loadWorkspaces();
	return workspace;
}

/** The workspace just made in this tab with this slug, once. */
export function takeMadeWorkspace(slug: string) {
	const workspace = madeHere.get(slug);
	madeHere.delete(slug);
	return workspace;
}

/** Only the fields given change: the title renames, the Instructions dialog sets the instructions. */
export async function updateWorkspace(id: string, changes: Partial<Omit<WorkspaceInput, "kind">>) {
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

/** The server's order: pinned first, then the newest made first, then by id. */
function listOrder(a: WorkspaceSummary, b: WorkspaceSummary) {
	return Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Sets the pin of the workspace in the list, in its sorted place. */
function placePin(id: string, pinned: boolean) {
	workspaces.value = workspaces.value.map((workspace) => (workspace.id === id ? { ...workspace, pinned } : workspace)).sort(listOrder);
}

/**
 * Pins the workspace at the top of the person's own list, or unpins it: the row moves at
 * once, and moves back with a toast when the server refuses. Nobody else sees the pin.
 */
export async function pinWorkspace(id: string, pinned: boolean) {
	placePin(id, pinned);
	const param = { id: encodeURIComponent(id) };
	try {
		if (pinned) await unwrap(client.api.workspaces[":id"].pin.$put({ param }));
		else await unwrap(client.api.workspaces[":id"].pin.$delete({ param }));
	} catch {
		placePin(id, !pinned);
		toast.error(pinned ? "The workspace could not be pinned." : "The workspace could not be unpinned.");
	}
}

export async function searchPeople(q: string): Promise<readonly Person[]> {
	return (await unwrap(client.api.people.$get({ query: { q } }), "People could not load.")).people;
}

/** The icon of a workspace's kind: a building for everyone, people when shared, a lock when only the owner uses it. */
export function kindIcon(workspace: Pick<WorkspaceSummary, "kind" | "memberCount">) {
	if (workspace.kind === "org") return "lucide-building-2";
	return workspace.memberCount ? "lucide-users" : "lucide-lock";
}

/** Who can use it, in a few words: the sidebar row's hint. */
export function sharedWith(workspace: Pick<WorkspaceSummary, "kind" | "access" | "memberCount">) {
	if (workspace.kind === "org") return "Everyone";
	if (workspace.access !== "owner") return "Shared with you";
	return workspace.memberCount ? `You and ${people(workspace.memberCount)}` : "Only you";
}

/** The owner shares a private workspace; an admin an organisation one (server/workspaces/access.ts). */
export function canShare(workspace: Pick<WorkspaceSummary, "kind" | "access">) {
	return workspace.kind === "org" ? isAdmin.value : workspace.access === "owner";
}

export { canEdit, people };
