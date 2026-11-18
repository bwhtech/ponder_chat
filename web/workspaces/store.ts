import { computed, ref } from "vue";
import { me } from "../account";
import { client, unwrap, type Answer } from "../api";
import { fromBoot } from "../boot";
import { toast } from "../toasts";
import { accessIcon, canEdit, canShare, isShared, people, sharedWith } from "./access";

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
/** General access: "ask" while everyone in the organisation can ask in it. */
export type OrgAccess = "none" | "ask";
/** Every workspace starts private: an admin opens it to everyone from Share. */
export type WorkspaceInput = { name: string; instructions: string };

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
	const asked = pinClock;
	try {
		const fresh = fromBoot("workspaces") ?? (await unwrap(client.api.workspaces.$get())).workspaces;
		workspaces.value = withPinsMadeSince(fresh, asked);
		settlePins(asked);
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
export async function updateWorkspace(id: string, changes: Partial<WorkspaceInput>) {
	const { workspace } = await unwrap(client.api.workspaces[":id"].$patch({ param: { id: encodeURIComponent(id) }, json: changes }), "The workspace could not be saved.");
	await loadWorkspaces();
	return workspace;
}

/**
 * Sharing, one change at a time (ShareDialog.vue): a person added or given a role, a person
 * removed, General access changed. Each answers the workspace as the person sees it now; the
 * sidebar is read again, for its icon.
 */
export async function setMember(id: string, userId: string, access: MemberAccess) {
	const param = { id: encodeURIComponent(id), userId: encodeURIComponent(userId) };
	const { workspace } = await unwrap(client.api.workspaces[":id"].members[":userId"].$put({ param, json: { access } }), SHARING_FAILED);
	void loadWorkspaces();
	return workspace;
}

export async function removeMember(id: string, userId: string) {
	const param = { id: encodeURIComponent(id), userId: encodeURIComponent(userId) };
	const { workspace } = await unwrap(client.api.workspaces[":id"].members[":userId"].$delete({ param }), SHARING_FAILED);
	void loadWorkspaces();
	return workspace;
}

export async function setOrgAccess(id: string, orgAccess: OrgAccess) {
	const { workspace } = await unwrap(client.api.workspaces[":id"].access.$put({ param: { id: encodeURIComponent(id) }, json: { orgAccess } }), SHARING_FAILED);
	void loadWorkspaces();
	return workspace;
}

const SHARING_FAILED = "The change could not be saved.";

export async function deleteWorkspace(id: string) {
	await unwrap(client.api.workspaces[":id"].$delete({ param: { id: encodeURIComponent(id) } }), "The workspace could not be deleted.");
	await loadWorkspaces();
}

/**
 * The server's order: pinned first, then the newest made first, then by id. `createdAt` is to
 * the microsecond, as the server orders it (server/workspaces/rows.ts), so rows made in the same
 * millisecond keep their place. ISO text in UTC sorts as the time does.
 */
function listOrder(a: WorkspaceSummary, b: WorkspaceSummary) {
	return Number(b.pinned) - Number(a.pinned) || descending(a.createdAt, b.createdAt) || descending(a.id, b.id);
}

function descending(a: string, b: string) {
	return a < b ? 1 : a > b ? -1 : 0;
}

/** Sets the pin of the workspace in the list, in its sorted place. */
function placePin(id: string, pinned: boolean) {
	workspaces.value = workspaces.value.map((workspace) => (workspace.id === id ? { ...workspace, pinned } : workspace)).sort(listOrder);
}

/**
 * The pins changed in this tab: what the person wants (`wanted`), what the server has
 * (`saved`), and whether a write runs. One write runs at a time for a workspace, so the server
 * ends with the person's last choice, whatever order the requests would otherwise take.
 * `changedAt` is the `pinClock` of the last choice or answer: a list asked for before it is
 * older than the pin (loadWorkspaces).
 */
type PinState = { wanted: boolean; saved: boolean; writing: boolean; changedAt: number };
const pinStates = new Map<string, PinState>();
let pinClock = 0;

/** The list, with each pin this tab changed after the list was asked for, or still writes, as the person chose it. */
function withPinsMadeSince(list: WorkspaceSummary[], asked: number) {
	const overlaid = list.map((workspace) => {
		const state = pinStates.get(workspace.id);
		const newer = state && (state.writing || state.changedAt > asked) && state.wanted !== workspace.pinned;
		return newer ? { ...workspace, pinned: state.wanted } : workspace;
	});
	return overlaid.some((workspace, index) => workspace !== list[index]) ? overlaid.sort(listOrder) : list;
}

/**
 * A list asked for after a pin's last choice and answer is newer than this tab's record of
 * it: another tab may have pinned or unpinned it since. That record goes, so the next Pin or
 * Unpin starts from the list and is sent. A pin still writing, or changed after the list was
 * asked for, keeps its record.
 */
function settlePins(asked: number) {
	for (const [id, state] of pinStates) if (!state.writing && state.changedAt <= asked) pinStates.delete(id);
}

/**
 * Pins the workspace at the top of the person's own list, or unpins it: the row moves at
 * once. A write waits for the one before it on the same workspace. When the server refuses
 * the person's last choice, the row moves back with a toast; a refusal of an older choice,
 * which the person has changed since, changes nothing. Nobody else sees the pin.
 */
export async function pinWorkspace(id: string, pinned: boolean) {
	const workspace = workspaceById(id);
	if (!workspace) return;
	const state = pinStates.get(id) ?? { wanted: workspace.pinned, saved: workspace.pinned, writing: false, changedAt: 0 };
	pinStates.set(id, state);
	state.wanted = pinned;
	state.changedAt = ++pinClock;
	placePin(id, pinned);
	// The write that runs sends this choice once it is done.
	if (state.writing) return;
	state.writing = true;
	while (state.wanted !== state.saved) {
		const sending = state.wanted;
		try {
			await sendPin(id, sending);
			state.saved = sending;
		} catch {
			if (state.wanted === sending) {
				state.wanted = state.saved;
				placePin(id, state.saved);
				toast.error(sending ? "The workspace could not be pinned." : "The workspace could not be unpinned.");
			}
		}
		state.changedAt = ++pinClock;
	}
	state.writing = false;
}

async function sendPin(id: string, pinned: boolean) {
	const param = { id: encodeURIComponent(id) };
	if (pinned) await unwrap(client.api.workspaces[":id"].pin.$put({ param }));
	else await unwrap(client.api.workspaces[":id"].pin.$delete({ param }));
}

export async function searchPeople(q: string): Promise<readonly Person[]> {
	return (await unwrap(client.api.people.$get({ query: { q } }), "People could not load.")).people;
}

/** Who deletes it: its owner, and admins while it is open to everyone (server/workspaces/access.ts). */
export function canDelete(workspace: Pick<WorkspaceSummary, "orgAccess" | "access">) {
	return workspace.access === "owner" || (workspace.orgAccess !== "none" && isAdmin.value);
}

export { accessIcon, canEdit, canShare, isShared, people, sharedWith };
