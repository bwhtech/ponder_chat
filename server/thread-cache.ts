import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Context as HonoContext } from "hono";
import * as Threads from "./threads/Threads.ts";
import * as ThreadRuns from "./workflow/runs.ts";

/**
 * GET /api/threads/:id, cached. A thread's version is its updated_at plus whether a
 * reply is running or its last reply failed, so the page revalidates with If-None-Match and gets a 304 when
 * nothing changed. Otherwise the response body, and its brotli, come from memory while
 * the version holds: a long thread is close to 1 MB of JSON and about a tenth of
 * that compressed.
 *
 * Brotli at quality 6 is smaller than gzip's default and about 5 times faster to make (4 ms
 * against 21 ms for 0.5 MB). Every browser takes it; gzip is made only for a client that
 * does not, and kept beside it. Both run on libuv's threads, not the event loop: a 20 ms
 * gzip on the loop held up every other request.
 *
 * One cache for the process: the service lives in the app's runtime, which every copy of
 * this module in the build shares.
 */
type Entry = { etag: string; json: string; brotli: Buffer; gzip?: Buffer };

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const toBrotli = (json: string) =>
	Effect.promise(() =>
		brotliAsync(json, { params: { [constants.BROTLI_PARAM_QUALITY]: 6, [constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(json) } }),
	);

const MAX_BYTES = 64 * 1024 * 1024;

export class ThreadCache extends Context.Service<
	ThreadCache,
	{
		/** The answer for the version, kept while it holds; `body` makes it once on a miss. */
		readonly entry: <E, R>(id: string, etag: string, body: Effect.Effect<string, E, R>) => Effect.Effect<Entry, E, R>;
		/** Drops a deleted thread. A saved one needs nothing: its new version misses the cache. */
		readonly forget: (id: string) => Effect.Effect<void>;
	}
>()("ponder/threads/ThreadCache") {}

const make = Effect.sync(() => {
	const lru = new Lru();
	const entry = <E, R>(id: string, etag: string, body: Effect.Effect<string, E, R>) =>
		Effect.suspend(() => {
			const found = lru.get(id, etag);
			if (found) return Effect.succeed(found);
			return Effect.flatMap(body, (json) => Effect.map(toBrotli(json), (brotli) => lru.remember(id, { etag, json, brotli })));
		});
	return ThreadCache.of({ entry, forget: (id) => Effect.sync(() => lru.forget(id)) });
});

export const layer = Layer.effect(ThreadCache, make);

/** The route's answer: a 304, the cached body (gzipped when the browser takes it), or no thread yet. */
export const threadResponse = Effect.fn("ThreadCache.respond")(function* (c: HonoContext, id: string, owner: string) {
	const threads = yield* Threads.Threads;
	const cache = yield* ThreadCache;
	const version = Option.getOrNull(yield* threads.version(id, owner));
	const run = Option.getOrUndefined(yield* ThreadRuns.ThreadRuns.use((runs) => runs.latest(id)));
	const running = Boolean(run && !run.finished);
	// The model kept erroring: the page offers Retry (workflow/chat.ts).
	const failed = Boolean(run?.finished && run.failed);
	// A thread not saved yet (or someone else's) has no version: always fresh, never cached.
	if (!version) return c.json({ messages: [], running: false }, 200, { "Cache-Control": "no-store" });
	// A deleted workspace lets its chats go without saving them, so the workspace is part of the version.
	const { updatedAt, workspaceId } = version;

	const etag = `"${updatedAt.getTime()}${running ? "-running" : ""}${failed ? "-failed" : ""}${workspaceId ? `-w${workspaceId}` : ""}"`;
	const headers = { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Accept-Encoding" };
	if (c.req.header("If-None-Match")?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) return c.body(null, 304, headers);

	// The messages go in as the JSON text Postgres holds, not parsed and written out again.
	const tail = `,"running":${running},"failed":${failed}${workspaceId ? `,"workspaceId":${JSON.stringify(workspaceId)}` : ""}}`;
	const entry = yield* cache.entry(
		id,
		etag,
		Effect.map(threads.loadJson(id), (messages) => `{"messages":${messages}${tail}`),
	);
	const accepts = c.req.header("Accept-Encoding") ?? "";
	if (/\bbr\b/.test(accepts)) {
		return c.body(new Uint8Array(entry.brotli), 200, { ...headers, "Content-Type": "application/json", "Content-Encoding": "br" });
	}
	if (/\bgzip\b/.test(accepts)) {
		entry.gzip ??= yield* Effect.promise(() => gzipAsync(entry.json));
		return c.body(new Uint8Array(entry.gzip), 200, { ...headers, "Content-Type": "application/json", "Content-Encoding": "gzip" });
	}
	return c.body(entry.json, 200, { ...headers, "Content-Type": "application/json" });
});

/** Entries by thread, the least recently used first, up to MAX_BYTES of JSON and gzip. */
class Lru {
	private entries = new Map<string, Entry>();
	private bytes = 0;

	get(id: string, etag: string) {
		const entry = this.entries.get(id);
		if (entry?.etag !== etag) return undefined;
		// Most recently used goes last; the first is evicted first.
		this.entries.delete(id);
		this.entries.set(id, entry);
		return entry;
	}

	remember(id: string, entry: Entry) {
		this.forget(id);
		this.entries.set(id, entry);
		this.bytes += size(entry);
		for (const [oldest, old] of this.entries) {
			if (this.bytes <= MAX_BYTES || oldest === id) break;
			this.entries.delete(oldest);
			this.bytes -= size(old);
		}
		return entry;
	}

	forget(id: string) {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.entries.delete(id);
		this.bytes -= size(entry);
	}
}

// gzip is rare (browsers take brotli), so it is left out of the count.
const size = (entry: Entry) => entry.json.length + entry.brotli.length;
