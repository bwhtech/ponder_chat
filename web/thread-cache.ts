import type { UIMessage } from "ai";
import { isMessages, isRecord, plainCopy } from "./json";

/**
 * Threads kept on this device, so opening one shows it at once and the server is asked
 * afterwards (stale-while-revalidate). In memory for this page, and in IndexedDB for the
 * next visit. `etag` is the server's version of the thread; null when the page wrote the
 * entry itself (after a reply), so the next check fetches it whole.
 */
export type CachedThread = { messages: UIMessage[]; running: boolean; failed?: boolean; workspaceId?: string; etag: string | null };

const memory = new Map<string, CachedThread>();
/**
 * Goes up for a thread each time it is written or forgotten. A read from IndexedDB that
 * was on its way meanwhile holds the older copy, so it must not land in memory.
 */
const generation = new Map<string, number>();
const bump = (id: string) => generation.set(id, (generation.get(id) ?? 0) + 1);
/** Threads kept in IndexedDB, most recently opened first. */
const KEEP = 30;
const DB = "ponder-chat";
const STORE = "threads";

let db: Promise<IDBDatabase | null> | undefined;

function openDb() {
	db ??= new Promise((resolve) => {
		if (typeof indexedDB === "undefined") return resolve(null);
		const request = indexedDB.open(DB, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE);
		request.onsuccess = () => resolve(request.result);
		// Private browsing or a full disk: memory only.
		request.onerror = () => resolve(null);
	});
	return db;
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
	const database = await openDb();
	if (!database) return undefined;
	return new Promise((resolve) => {
		const request = work(database.transaction(STORE, mode).objectStore(STORE));
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => resolve(undefined);
	});
}

/** The thread from memory, or from IndexedDB on a fresh page. */
export async function readThread(id: string): Promise<CachedThread | undefined> {
	const inMemory = memory.get(id);
	if (inMemory) return inMemory;
	const before = generation.get(id);
	const stored = await run<unknown>("readonly", (store) => store.get(id));
	// Written or forgotten while IndexedDB answered: what memory holds now is newer.
	if (generation.get(id) !== before) return memory.get(id);
	const thread = isRecord(stored) && isRecord(stored.thread) ? threadFrom(stored.thread, stored.thread.etag) : undefined;
	if (thread) memory.set(id, thread);
	return thread;
}

/** A thread from JSON: the server's answer, or what IndexedDB kept. Undefined when it is not one. */
export function threadFrom(value: unknown, etag: unknown): CachedThread | undefined {
	if (!isRecord(value) || !isMessages(value.messages)) return undefined;
	return {
		messages: value.messages,
		running: value.running === true,
		failed: value.failed === true,
		...(typeof value.workspaceId === "string" && value.workspaceId && { workspaceId: value.workspaceId }),
		etag: typeof etag === "string" ? etag : null,
	};
}

/** The thread from memory only: no wait, for the first paint. */
export const peekThread = (id: string) => memory.get(id);

export function writeThread(id: string, thread: CachedThread) {
	bump(id);
	memory.set(id, thread);
	// Messages from the chat are reactive proxies; IndexedDB needs plain data.
	const plain = { thread: { ...thread, messages: plainCopy(thread.messages) }, openedAt: Date.now() };
	void run("readwrite", (store) => store.put(plain, id)).then(prune);
}

export function forgetThread(id: string) {
	bump(id);
	memory.delete(id);
	void run("readwrite", (store) => store.delete(id));
}

/** Keeps the KEEP threads opened last. */
async function prune() {
	const entries = await ages();
	if (entries.length <= KEEP) return;
	const byAge = entries.sort((a, b) => b.openedAt - a.openedAt);
	for (const { key } of byAge.slice(KEEP)) {
		bump(String(key));
		memory.delete(String(key));
		void run("readwrite", (store) => store.delete(key));
	}
}

/** Each kept thread's key with when it was opened, read in one pass so each key meets its own entry. */
async function ages(): Promise<{ key: IDBValidKey; openedAt: number }[]> {
	const database = await openDb();
	if (!database) return [];
	return new Promise((resolve) => {
		const found: { key: IDBValidKey; openedAt: number }[] = [];
		const request = database.transaction(STORE, "readonly").objectStore(STORE).openCursor();
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) return resolve(found);
			found.push({ key: cursor.primaryKey, openedAt: (cursor.value as { openedAt?: number })?.openedAt ?? 0 });
			cursor.continue();
		};
		request.onerror = () => resolve(found);
	});
}
