import type { UIMessage } from "ai";

/**
 * Threads kept on this device, so opening one shows it at once and the server is asked
 * afterwards (stale-while-revalidate). In memory for this page, and in IndexedDB for the
 * next visit. `etag` is the server's version of the thread; null when the page wrote the
 * entry itself (after a reply), so the next check fetches it whole.
 */
export type CachedThread = { messages: UIMessage[]; running: boolean; etag: string | null };

const memory = new Map<string, CachedThread>();
/** Threads kept in IndexedDB, most recently opened first. */
const KEEP = 30;
const DB = "seva-chat";
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
	const stored = await run<{ thread: CachedThread } | undefined>("readonly", (store) => store.get(id));
	if (stored) memory.set(id, stored.thread);
	return stored?.thread;
}

/** The thread from memory only: no wait, for the first paint. */
export const peekThread = (id: string) => memory.get(id);

export function writeThread(id: string, thread: CachedThread) {
	memory.set(id, thread);
	// Messages from the chat are reactive proxies; IndexedDB needs plain data.
	const plain = { thread: { ...thread, messages: JSON.parse(JSON.stringify(thread.messages)) }, openedAt: Date.now() };
	void run("readwrite", (store) => store.put(plain, id)).then(prune);
}

export function forgetThread(id: string) {
	memory.delete(id);
	void run("readwrite", (store) => store.delete(id));
}

/** Keeps the KEEP threads opened last. */
async function prune() {
	const keys = (await run("readonly", (store) => store.getAllKeys())) ?? [];
	if (keys.length <= KEEP) return;
	const all = (await run<{ openedAt: number }[]>("readonly", (store) => store.getAll())) ?? [];
	const byAge = keys.map((key, index) => ({ key, openedAt: all[index]?.openedAt ?? 0 })).sort((a, b) => b.openedAt - a.openedAt);
	for (const { key } of byAge.slice(KEEP)) {
		memory.delete(String(key));
		void run("readwrite", (store) => store.delete(key));
	}
}
