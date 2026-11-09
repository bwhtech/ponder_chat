import type { UIMessage } from "ai";
import { nameFromFirstMessage } from "./thread-name";
import { request } from "./api";
import { createStore } from "./store";
import { forgetThread, generationOf, peekThread, readThread, writeThread, type CachedThread } from "./thread-cache";

/**
 * The person's threads and the one open now. The open thread lives in the URL
 * (`?t=<id>`), so a link, a reload and Back / Forward all land on it. Switching
 * loads the thread's messages without reloading the page.
 *
 * A thread kept on this device (thread-cache.ts) shows at once, and the server is
 * asked afterwards: a 304 when nothing changed, or the newer thread, which replaces
 * the chat unless a reply is on its way. The list is kept in localStorage the same way.
 */
export type ThreadSummary = { id: string; title: string; updatedAt: string; messages: number };

const LIST_KEY = "ponder-chat:threads";
export const threads = createStore<ThreadSummary[]>([]);
/** The list came from the server, or from this device: until then the sidebar shows skeleton rows. */
export const listLoaded = createStore(false);
export const current = createStore("");
export const messages = createStore<UIMessage[]>([]);
/** Fetching a thread this device does not have: the chat shows a skeleton. */
export const loading = createStore(false);
/** The open thread had a reply still being written when it was loaded; the chat reconnects to it. */
export const running = createStore(false);
/** Goes up when a newer copy of the open thread replaces the one shown, so the chat remounts with it. */
export const revision = createStore(0);
/**
 * The open chat is sending or receiving. A newer copy from the server is then dropped rather
 * than cut the reply off: when the reply ends, the chat's own messages are the newest, and it
 * saves them (remember) without an etag, so the next open fetches the thread whole.
 */
export const chatBusy = createStore(false);
/**
 * Threads whose chat closed after an error. The run may go on, or have ended, on the server,
 * so the copy kept here may be behind: the next open waits for the server's copy.
 */
const unsure = new Set<string>();
// Each open() takes a number; a slower answer for a thread no longer open is dropped.
let opening = 0;
const inflight = new Map<string, Promise<CachedThread | "same" | undefined>>();
/** Threads started on this page that the server's list may not have yet. */
const pending = new Map<string, ThreadSummary>();
let listening = false;

/** Opens the thread in the URL, or a new one, and keeps it in step with Back / Forward. */
export async function init() {
	// Read now, not on load: signing in (account.ts) may have just cleared another person's list.
	threads.set(storedList());
	listLoaded.set(threads.get().length > 0);
	// Once for the page, however often init runs.
	if (!listening) {
		listening = true;
		addEventListener("popstate", () => {
			const id = new URL(location.href).searchParams.get("t");
			if (id && id !== current.get()) void open(id, { push: false });
			else if (!id) start({ push: false });
		});
	}
	const id = new URL(location.href).searchParams.get("t");
	await Promise.all([refresh(), id ? open(id, { push: false }) : start({ push: false })]);
}

export async function refresh() {
	try {
		const response = await fetch("/api/threads");
		if (!response.ok) return;
		const fresh: ThreadSummary[] = (await response.json()).threads;
		for (const id of pending.keys()) if (fresh.some((thread) => thread.id === id)) pending.delete(id);
		threads.set([...pending.values(), ...fresh]);
		localStorage.setItem(LIST_KEY, JSON.stringify(fresh));
	} catch {
		// Offline: keep the list this device has.
	} finally {
		listLoaded.set(true);
	}
}

export async function open(id: string, { push = true } = {}) {
	const again = id === current.get();
	if (again && !unsure.has(id)) return;
	const token = ++opening;
	const trusted = !unsure.delete(id);
	// The messages change with the id, so the chat never mounts the new thread with the old one's messages.
	const peeked = trusted ? peekThread(id) : undefined;
	if (peeked) show(peeked);
	else loading.set(true);
	current.set(id);
	if (!again) setUrl(id, push);

	const cached = peeked ?? (trusted ? await readThread(id) : undefined);
	if (token !== opening) return;
	if (cached && !peeked) show(cached);

	const fresh = await fetchThread(id, cached?.etag ?? null);
	if (token !== opening) return;
	loading.set(false);
	if (!cached) return show(fresh && fresh !== "same" ? fresh : (peekThread(id) ?? { messages: [], running: false, etag: null }));
	// Nothing new, or the same messages under a new version (the page saved them itself).
	if (!fresh || fresh === "same" || sameThread(cached, fresh)) return;
	// A reply is on its way: the chat's own messages will be newer than this copy (chatBusy).
	if (chatBusy.get()) return;
	show(fresh);
	revision.set((value) => value + 1);
}

/**
 * The chat of this thread closed after an error (unsure). For the open thread (Memory shows)
 * the server is asked now, so the chat mounts again only with its copy, however the person comes back.
 */
export function markUnsure(id: string) {
	unsure.add(id);
	if (id === current.get()) void open(id, { push: false });
}

/** Fetches a thread into the cache ahead of a click: on hover, focus or touch in the list. */
export function prefetch(id: string) {
	if (id === current.get() || peekThread(id) || inflight.has(id)) return;
	void readThread(id).then((cached) => cached || fetchThread(id, null));
}

/** The chat's own messages after a reply, so coming back to the thread is instant. */
export function remember(id: string, thread: Omit<CachedThread, "etag">) {
	writeThread(id, { ...thread, etag: null });
	// The open thread too: back from Memory, the chat mounts again with these, not the ones it opened with.
	if (id === current.get()) {
		messages.set(thread.messages);
		running.set(thread.running);
	}
}

/** The server's copy, "same" when it matches `etag` (a 304), or undefined when it could not be reached or is older than the chat's. */
function fetchThread(id: string, etag: string | null) {
	const pending = inflight.get(id);
	if (pending) return pending;
	const request = (async () => {
		const before = generationOf(id);
		try {
			const response = await fetch(`/api/threads/${encodeURIComponent(id)}`, {
				// The cache here does the revalidating; the browser's would only add a second copy.
				cache: "no-store",
				headers: etag ? { "If-None-Match": etag } : {},
			});
			if (response.status === 304) return "same" as const;
			if (!response.ok) return undefined;
			const body = await response.json();
			// The chat saved the thread meanwhile (remember): this copy is older, so it is dropped.
			if (generationOf(id) !== before) return undefined;
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
	loading.set(false);
	messages.set(thread.messages);
	running.set(thread.running);
}

function sameThread(a: CachedThread, b: CachedThread) {
	return a.running === b.running && JSON.stringify(a.messages) === JSON.stringify(b.messages);
}

/** A new, empty thread. It joins the list when its first message goes out (added). */
export function start({ push = true } = {}) {
	opening++;
	const id = crypto.randomUUID().slice(0, 8);
	messages.set([]);
	running.set(false);
	loading.set(false);
	current.set(id);
	setUrl(id, push);
}

/**
 * A new thread's first message went out: the thread joins the top of the list now, named by
 * that message, as the server names it until it has a title. The server names it with a cheap
 * model a moment later (server/thread-title.ts), so the list is asked again until the name changes.
 */
export function added(id: string, text: string) {
	if (threads.get().some((thread) => thread.id === id)) return;
	const thread = { id, title: nameFromFirstMessage(text), updatedAt: new Date().toISOString(), messages: 1 };
	pending.set(id, thread);
	threads.set([thread, ...threads.get()]);
	void waitForTitle(id, thread.title);
}

async function waitForTitle(id: string, untitled: string) {
	for (const wait of [1_500, 3_000, 6_000]) {
		await new Promise((resolve) => setTimeout(resolve, wait));
		await refresh();
		const thread = threads.get().find((each) => each.id === id);
		if (!thread || thread.title !== untitled) return;
	}
	// Still not on the server (the message was refused, say): it leaves the list.
	if (pending.delete(id)) threads.set(threads.get().filter((thread) => thread.id !== id));
}

export async function rename(id: string, title: string) {
	await request(`/api/threads/${encodeURIComponent(id)}`, { method: "PATCH", body: { title }, failure: "The thread could not be renamed." });
	await refresh();
}

export async function remove(id: string) {
	await request(`/api/threads/${encodeURIComponent(id)}`, { method: "DELETE", failure: "The thread could not be deleted." });
	forgetThread(id);
	pending.delete(id);
	await refresh();
	if (id === current.get()) {
		const next = threads.get()[0];
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
