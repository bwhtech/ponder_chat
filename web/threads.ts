import type { UIMessage } from "ai";
import { computed, ref, shallowRef } from "vue";
import { forgetThread, peekThread, readThread, writeThread, type CachedThread } from "./thread-cache";

/**
 * The person's threads and the one open now. The open thread lives in the URL
 * (`?t=<id>`), so a link, a reload and Back / Forward all land on it. Switching
 * loads the thread's messages without reloading the page.
 *
 * A thread kept on this device (thread-cache.ts) shows at once, and the server is
 * asked afterwards: a 304 when nothing changed, or the newer thread, which replaces
 * the chat unless the person is mid-reply. The list is kept in localStorage the same way.
 */
export type ThreadSummary = { id: string; title: string; updatedAt: string; messages: number };

const LIST_KEY = "seva-chat:threads";
const threads = ref<ThreadSummary[]>([]);
/** The list came from the server, or from this device: until then the sidebar shows skeleton rows. */
const listLoaded = ref(false);
const current = ref("");
const messages = shallowRef<UIMessage[]>([]);
/** Fetching a thread this device does not have: the chat shows a skeleton. */
const loading = ref(false);
/** The open thread had a reply still being written when it was loaded; the chat reconnects to it. */
const running = ref(false);
/** Goes up when a newer copy of the open thread replaces the one shown, so the chat remounts with it. */
const revision = ref(0);
/** The open chat is sending or receiving; a newer copy waits rather than cut it off. */
const chatBusy = ref(false);
// Each open() takes a number; a slower answer for a thread no longer open is dropped.
let opening = 0;
const inflight = new Map<string, Promise<CachedThread | "same" | undefined>>();

export function useThreads() {
	const currentThread = computed(() => threads.value.find((thread) => thread.id === current.value));
	return {
		threads,
		listLoaded,
		current,
		currentThread,
		messages,
		running,
		loading,
		revision,
		chatBusy,
		refresh,
		open,
		prefetch,
		remember,
		start,
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
	const id = new URL(location.href).searchParams.get("t");
	await Promise.all([refresh(), id ? open(id, { push: false }) : start({ push: false })]);
	addEventListener("popstate", () => {
		const id = new URL(location.href).searchParams.get("t");
		if (id && id !== current.value) void open(id, { push: false });
		else if (!id) start({ push: false });
	});
}

async function refresh() {
	try {
		const response = await fetch("/api/threads");
		if (!response.ok) return;
		threads.value = (await response.json()).threads;
		localStorage.setItem(LIST_KEY, JSON.stringify(threads.value));
	} catch {
		// Offline: keep the list this device has.
	} finally {
		listLoaded.value = true;
	}
}

async function open(id: string, { push = true } = {}) {
	if (id === current.value) return;
	const token = ++opening;
	// The messages change with the id, so the chat never mounts the new thread with the old one's messages.
	const peeked = peekThread(id);
	if (peeked) show(peeked);
	else loading.value = true;
	current.value = id;
	setUrl(id, push);

	const cached = peeked ?? (await readThread(id));
	if (token !== opening) return;
	if (cached && !peeked) show(cached);

	const fresh = await fetchThread(id, cached?.etag ?? null);
	if (token !== opening) return;
	loading.value = false;
	if (!cached) return show(fresh && fresh !== "same" ? fresh : { messages: [], running: false, etag: null });
	// Nothing new, or the same messages under a new version (the page saved them itself).
	if (!fresh || fresh === "same" || sameThread(cached, fresh) || chatBusy.value) return;
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
			const body = await response.json();
			const thread: CachedThread = { messages: body.messages, running: !!body.running, etag: response.headers.get("ETag") };
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
	messages.value = thread.messages;
	running.value = thread.running;
}

function sameThread(a: CachedThread, b: CachedThread) {
	return a.running === b.running && JSON.stringify(a.messages) === JSON.stringify(b.messages);
}

/** A new, empty thread. It joins the list once its first reply is saved. */
function start({ push = true } = {}) {
	opening++;
	const id = crypto.randomUUID().slice(0, 8);
	messages.value = [];
	running.value = false;
	loading.value = false;
	current.value = id;
	setUrl(id, push);
}

async function rename(id: string, title: string) {
	const response = await fetch(`/api/threads/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title }),
	});
	if (!response.ok) throw new Error("The thread could not be renamed.");
	await refresh();
}

async function remove(id: string) {
	const response = await fetch(`/api/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!response.ok) throw new Error("The thread could not be deleted.");
	forgetThread(id);
	await refresh();
	if (id === current.value) {
		const next = threads.value[0];
		if (next) await open(next.id);
		else start();
	}
}

function storedList(): ThreadSummary[] {
	try {
		return JSON.parse(localStorage.getItem(LIST_KEY) ?? "[]");
	} catch {
		return [];
	}
}

function setUrl(id: string, push: boolean) {
	const url = new URL(location.href);
	url.searchParams.set("t", id);
	if (push) history.pushState(null, "", url);
	else history.replaceState(null, "", url);
}
