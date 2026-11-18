import type { ThreadSummary } from "../threads";
import type { WorkspaceDetail } from "./store";

/**
 * Workspaces opened on this page, so opening one again shows it at once and the server is
 * asked afterwards (stale-while-revalidate), as a chat does (thread-cache.ts): the workspace,
 * and the person's chats in it. Pointing at a row in the sidebar fetches both ahead of the
 * click (store.ts, threads.ts), as pointing at a chat does.
 *
 * In memory only, for this page. A copy kept on the device for the next visit could show a
 * workspace's people and sources to a person removed from it since, until the server
 * answered; and a reload asks the server anyway. Signing out loads the page again, so it
 * empties this too.
 *
 * What the page shows is the best copy: the page writes each version it shows here
 * (WorkspacePage.vue), so a change made there (instructions, sources, sharing, a new name) is
 * what the next visit shows. An answer the page dropped as older than its own change never
 * lands here. A workspace the server no longer has for the person (a 404, or missing from the
 * sidebar's list) leaves at once, and a deleted chat leaves every list here.
 */
type Entry = { workspace?: WorkspaceDetail; chats?: ThreadSummary[] };

/** Workspaces kept, by id, the one used longest ago first. */
const KEEP = 20;
const entries = new Map<string, Entry>();

function keep(id: string, change: Entry) {
	const entry = { ...entries.get(id), ...change };
	// Last in the map: the most recently used.
	entries.delete(id);
	entries.set(id, entry);
	for (const oldest of entries.keys()) {
		if (entries.size <= KEEP) break;
		entries.delete(oldest);
	}
}

/** The workspace by its id or its slug (the `?w=` of the URL), from memory: no wait, for the first paint. */
export function peekWorkspace(key: string) {
	for (const { workspace } of entries.values()) if (workspace && (workspace.id === key || workspace.slug === key)) return workspace;
	return undefined;
}

export const peekWorkspaceChats = (id: string) => entries.get(id)?.chats;

export const writeWorkspace = (workspace: WorkspaceDetail) => keep(workspace.id, { workspace });

export const writeWorkspaceChats = (id: string, chats: ThreadSummary[]) => keep(id, { chats });

export function forgetWorkspace(id: string) {
	entries.delete(id);
}

/** The sidebar's list came: a workspace not in it was deleted, or the person lost it. */
export function keepOnlyWorkspaces(ids: ReadonlySet<string>) {
	for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
}

/** A chat was deleted: no list here shows it again. */
export function forgetChat(chatId: string) {
	for (const [id, entry] of entries) {
		if (entry.chats?.some((chat) => chat.id === chatId)) entries.set(id, { ...entry, chats: entry.chats.filter((chat) => chat.id !== chatId) });
	}
}
