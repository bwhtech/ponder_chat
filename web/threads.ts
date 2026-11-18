import type { UIMessage } from "ai";
import { computed, ref, shallowRef, watch } from "vue";
import { nameFromFirstMessage } from "../shared/thread-name";
import { client, unwrap, type Answer } from "./api";
import { fromBoot } from "./boot";
import { isRecord } from "./json";
import { forgetThread, peekThread, readThread, threadFrom, writeThread, type CachedThread } from "./thread-cache";
import { openWorkspaceKey } from "./workspaces/store";

/**
 * The person's threads and the one open now. The open thread lives in the URL
 * (`?t=<id>`), so a link, a reload and Back / Forward all land on it. Switching
 * loads the thread's messages without reloading the page.
 *
 * A thread kept on this device (thread-cache.ts) shows at once, and the server is
 * asked afterwards: a 304 when nothing changed, or the newer thread, which replaces
 * the chat unless a reply is on its way. The list is kept in localStorage the same way.
 *
 * A workspace page (`?w=<slug>`) takes the open thread's place in the URL; opening a thread
 * takes it back.
 */
export type ThreadSummary = Answer<typeof client.api.threads.$get>["threads"][number];

const LIST_KEY = "ponder-chat:threads";
const threads = ref<ThreadSummary[]>([]);
/** The list came from the server, or from this device: until then the sidebar shows skeleton rows. */
const listLoaded = ref(false);
const current = ref("");
const messages = shallowRef<UIMessage[]>([]);
/** Fetching a thread this device does not have: the chat shows a skeleton. */
const loading = ref(false);
/** The open thread had a reply still being written when it was loaded; the chat reconnects to it. */
const running = ref(false);
/** The open thread's last reply failed (the model kept erroring); the chat offers Retry. */
const failed = ref(false);
/** The open thread's workspace, from the server's copy; null for a thread in no workspace, or a new one. */
const threadWorkspace = ref<string | null>(null);
/** Goes up when a newer copy of the open thread replaces the one shown, so the chat remounts with it. */
const revision = ref(0);
/**
 * The open chat is sending or receiving. A newer copy from the server is then dropped rather
 * than cut the reply off: when the reply ends, the chat's own messages are the newest, and it
 * saves them (remember) without an etag, so the next open fetches the thread whole.
 */
const chatBusy = ref(false);
// Each open() takes a number; a slower answer for a thread no longer open is dropped.
let opening = 0;
const inflight = new Map<string, Promise<CachedThread | "same" | undefined>>();
/** Threads started on this page that the server's list may not have yet. */
const pending = new Map<string, ThreadSummary>();

export function useThreads() {
	const currentThread = computed(() => threads.value.find((thread) => thread.id === current.value));
	/** The open chat's workspace: from the list, or from the thread itself when the list does not have it yet. */
	const currentWorkspace = computed(() => currentThread.value?.workspaceId ?? threadWorkspace.value ?? undefined);
	return {
		threads,
		listLoaded,
		current,
		currentThread,
		currentWorkspace,
		messages,
		running,
		failed,
		loading,
		revision,
		chatBusy,
		reload,
		refresh,
		open,
		resume,
		prefetch,
		remember,
		start,
		added,
		rename,
		remove,
		init,
	};
}

/** Opens the thread in the URL, or a new one, and keeps it in step with Back / Forward. */
async function init() {
	// Read now, not on load: signing in (account.ts) may have just cleared another person's list.
	threads.value = storedList();
	listLoaded.value = threads.value.length > 0;
	const params = new URL(location.href).searchParams;
	const id = params.get("t");
	// A workspace page has no thread open until one is picked or started.
	await Promise.all([refresh(), id ? open(id, { push: false }) : params.has("w") ? undefined : start({ push: false })]);
	addEventListener("popstate", () => {
		const params = new URL(location.href).searchParams;
		const id = params.get("t");
		if (id && id !== current.value) void open(id, { push: false });
		else if (!id && !params.has("w")) start({ push: false });
	});
}

async function refresh() {
	try {
		const fresh: ThreadSummary[] | undefined = fromBoot("threads") ?? (await fetchList());
		if (!fresh) return;
		for (const id of pending.keys()) if (fresh.some((thread) => thread.id === id)) pending.delete(id);
		threads.value = [...pending.values(), ...fresh];
		localStorage.setItem(LIST_KEY, JSON.stringify(fresh));
	} catch {
		// Offline: keep the list this device has.
	} finally {
		listLoaded.value = true;
	}
}

/** The list from the server; undefined when it refused. The first one comes with the page (boot.ts). */
async function fetchList(): Promise<ThreadSummary[] | undefined> {
	const response = await client.api.threads.$get({ query: {} });
	return response.ok ? (await response.json()).threads : undefined;
}

/**
 * The person's chats in one workspace, newest first: the server's list for the workspace,
 * which it filters before its limit of 200, so a workspace's older chats are there however
 * many newer chats are elsewhere. With the chats of the person's list in that workspace,
 * which has a chat started on this page and its new title first. Asked again whenever the
 * person's list changes (a refresh, a rename, a delete), so the two never disagree for long.
 */
export function useWorkspaceThreads(workspaceId: () => string) {
	const fetched = ref<ThreadSummary[]>([]);
	// Each ask takes a number; a slower answer for another workspace, or an older one, is dropped.
	let asking = 0;
	async function ask() {
		const id = workspaceId();
		const token = ++asking;
		if (!id) return void (fetched.value = []);
		try {
			const response = await client.api.threads.$get({ query: { workspace: id } });
			if (token === asking && response.ok) fetched.value = (await response.json()).threads;
		} catch {
			// Offline: the person's list still gives the chats it has.
		}
	}
	watch([workspaceId, threads], ask, { immediate: true });
	const chats = computed(() => {
		const id = workspaceId();
		if (!id) return [];
		const byId = new Map(fetched.value.filter((thread) => thread.workspaceId === id).map((thread) => [thread.id, thread]));
		if (listLoaded.value) for (const thread of threads.value) if (thread.workspaceId === id) byId.set(thread.id, thread);
		return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	});
	return { chats };
}

async function open(id: string, { push = true } = {}) {
	// Open already, behind a workspace page or Memory: only the URL goes back to it. Its chat
	// mounts again, and the shell calls resume() for that.
	if (id === current.value) return void (new URL(location.href).searchParams.get("t") !== id && setUrl(id, push));
	const loaded = load(id);
	setUrl(id, push);
	await loaded;
}

/**
 * The open thread's chat mounts again, back from Memory or a workspace page (Shell.vue).
 * `messages` still holds the thread as it opened; the chat's own messages since then are in
 * the cache (remember), so it shows those, and asks the server. A new thread that has
 * sent nothing has no copy, and nothing to restore.
 */
function resume() {
	if (peekThread(current.value)) void load(current.value);
}

/** Shows the thread from this device at once, then asks the server for a newer copy. */
async function load(id: string) {
	const token = ++opening;
	// The messages change with the id, so the chat never mounts the new thread with the old one's messages.
	const peeked = peekThread(id);
	if (peeked) show(peeked);
	else loading.value = true;
	current.value = id;

	const cached = peeked ?? (await readThread(id));
	if (token !== opening) return;
	if (cached && !peeked) show(cached);

	const fresh = await fetchThread(id, cached?.etag ?? null);
	if (token !== opening) return;
	loading.value = false;
	if (fresh && fresh !== "same") threadWorkspace.value = fresh.workspaceId ?? null;
	if (!cached) return show(fresh && fresh !== "same" ? fresh : { messages: [], running: false, etag: null });
	// Nothing new, or the same messages under a new version (the page saved them itself).
	if (!fresh || fresh === "same" || sameThread(cached, fresh)) return;
	// A reply is on its way: the chat's own messages will be newer than this copy (chatBusy).
	if (chatBusy.value) return;
	show(fresh);
	revision.value++;
}

/**
 * The open thread as the server saved it, in place of the page's copy: an answer from
 * another tab, or an earlier reply, went ahead of this page (ChatView.vue).
 */
async function reload(id: string) {
	const fresh = await fetchThread(id, null);
	if (!fresh || fresh === "same" || id !== current.value) return;
	show(fresh);
	revision.value++;
}

/** Fetches a thread into the cache ahead of a click: on hover, focus or touch in the list. */
function prefetch(id: string) {
	if (id === current.value || peekThread(id) || inflight.has(id)) return;
	void readThread(id).then((cached) => cached || fetchThread(id, null));
}

/** The chat's own messages after a reply, so coming back to the thread is instant. */
function remember(id: string, thread: Omit<CachedThread, "etag">) {
	writeThread(id, { ...thread, etag: null });
}

/** The server's copy, "same" when it matches `etag` (a 304), or undefined when it could not be reached. */
function fetchThread(id: string, etag: string | null) {
	const pending = inflight.get(id);
	if (pending) return pending;
	const request = (async () => {
		try {
			const response = await fetch(`/api/threads/${encodeURIComponent(id)}`, {
				// The cache here does the revalidating; the browser's would only add a second copy.
				cache: "no-store",
				headers: etag ? { "If-None-Match": etag } : {},
			});
			if (response.status === 304) return "same" as const;
			if (!response.ok) return undefined;
			const thread = threadFrom(await response.json(), response.headers.get("ETag"));
			if (!thread) return undefined;
			// Not saved yet (a new thread in the URL): nothing to keep.
			if (thread.etag) writeThread(id, thread);
			return thread;
		} catch {
			return undefined;
		} finally {
			inflight.delete(id);
		}
	})();
	inflight.set(id, request);
	return request;
}

function show(thread: CachedThread) {
	loading.value = false;
	threadWorkspace.value = thread.workspaceId ?? null;
	messages.value = thread.messages;
	running.value = thread.running;
	failed.value = !!thread.failed;
}

function sameThread(a: CachedThread, b: CachedThread) {
	return a.running === b.running && !!a.failed === !!b.failed && JSON.stringify(a.messages) === JSON.stringify(b.messages);
}

/** A new, empty thread. It joins the list when its first message goes out (added). */
function start({ push = true } = {}) {
	opening++;
	const id = crypto.randomUUID().slice(0, 8);
	messages.value = [];
	running.value = false;
	failed.value = false;
	loading.value = false;
	threadWorkspace.value = null;
	current.value = id;
	setUrl(id, push);
}

/**
 * A new thread's first message went out: the thread joins the top of the list now, named by
 * that message, as the server names it until it has a title. The server names it with a cheap
 * model a moment later (server/thread-title.ts), so the list is asked again until the name changes.
 */
function added(id: string, text: string, workspaceId?: string) {
	if (threads.value.some((thread) => thread.id === id)) return;
	const thread = { id, title: nameFromFirstMessage(text), updatedAt: new Date().toISOString(), messages: 1, ...(workspaceId && { workspaceId }) };
	pending.set(id, thread);
	threads.value = [thread, ...threads.value];
	void waitForTitle(id, thread.title);
}

async function waitForTitle(id: string, untitled: string) {
	for (const wait of [1_500, 3_000, 6_000]) {
		await new Promise((resolve) => setTimeout(resolve, wait));
		await refresh();
		const thread = threads.value.find((each) => each.id === id);
		if (!thread || thread.title !== untitled) return;
	}
	// Still not on the server (the message was refused, say): it leaves the list.
	if (pending.delete(id)) threads.value = threads.value.filter((thread) => thread.id !== id);
}

async function rename(id: string, title: string) {
	await unwrap(client.api.threads[":id"].$patch({ param: { id: encodeURIComponent(id) }, json: { title } }), "The thread could not be renamed.");
	await refresh();
}

async function remove(id: string) {
	await unwrap(client.api.threads[":id"].$delete({ param: { id: encodeURIComponent(id) } }), "The thread could not be deleted.");
	forgetThread(id);
	pending.delete(id);
	await refresh();
	if (id === current.value) {
		const next = threads.value[0];
		if (next) await open(next.id);
		else start();
	}
}

function storedList(): ThreadSummary[] {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(LIST_KEY) ?? "[]");
		return Array.isArray(stored) ? stored.filter(isThreadSummary) : [];
	} catch {
		return [];
	}
}

function isThreadSummary(value: unknown): value is ThreadSummary {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.title === "string" &&
		typeof value.updatedAt === "string" &&
		typeof value.messages === "number" &&
		(value.workspaceId === undefined || typeof value.workspaceId === "string")
	);
}

function setUrl(id: string, push: boolean) {
	const url = new URL(location.href);
	url.searchParams.delete("w");
	openWorkspaceKey.value = "";
	url.searchParams.set("t", id);
	if (push) history.pushState(null, "", url);
	else history.replaceState(null, "", url);
}
