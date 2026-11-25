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
type Entry = {
	etag: string;
	json: string;
	brotli: Buffer;
	/** Made on the first request without brotli, once (ThreadCache.gzip). */
	gzip?: Promise<Buffer>;
	/** The gzip's size once it is made, counted with the rest. */
	gzipBytes: number;
};

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
		/** The entry's gzip, for a client without brotli: made once, and counted in the cache's size. */
		readonly gzip: (id: string, entry: Entry) => Effect.Effect<Buffer>;
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
			return Effect.flatMap(body, (json) => Effect.map(toBrotli(json), (brotli) => lru.remember(id, { etag, json, brotli, gzipBytes: 0 })));
		});
	return ThreadCache.of({ entry, gzip: (id, entry) => Effect.promise(() => lru.gzipOf(id, entry)), forget: (id) => Effect.sync(() => lru.forget(id)) });
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
	const takes = acceptedEncodings(c.req.header("Accept-Encoding") ?? "");
	if (takes("br")) {
		return c.body(new Uint8Array(entry.brotli), 200, { ...headers, "Content-Type": "application/json", "Content-Encoding": "br" });
	}
	if (takes("gzip")) {
		const zipped = yield* cache.gzip(id, entry);
		return c.body(new Uint8Array(zipped), 200, { ...headers, "Content-Type": "application/json", "Content-Encoding": "gzip" });
	}
	return c.body(entry.json, 200, { ...headers, "Content-Type": "application/json" });
});

/**
 * Whether the request takes an encoding: named in Accept-Encoding, or under `*`, with a
 * quality above 0. `gzip, br;q=0` refuses brotli (RFC 9110, section 12.5.3).
 */
export function acceptedEncodings(header: string) {
	const qualities = new Map<string, number>();
	for (const item of header.split(",")) {
		const [name = "", ...params] = item.split(";").map((part) => part.trim().toLowerCase());
		if (!name) continue;
		const q = params.find((param) => param.startsWith("q="));
		qualities.set(name, q ? Number(q.slice(2)) || 0 : 1);
	}
	return (encoding: string) => (qualities.get(encoding) ?? qualities.get("*") ?? 0) > 0;
}

/** Entries by thread, the least recently used first, up to MAX_BYTES of JSON and its compressed copies. */
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
		this.evictFor(id);
		return entry;
	}

	/** The entry's gzip, made once even for requests at the same time. Counted while the entry is kept. */
	gzipOf(id: string, entry: Entry): Promise<Buffer> {
		entry.gzip ??= gzipAsync(entry.json).then((zipped) => {
			if (this.entries.get(id) === entry) {
				entry.gzipBytes = zipped.length;
				this.bytes += zipped.length;
				this.evictFor(id);
			}
			return zipped;
		});
		return entry.gzip;
	}

	/** Evicts the least recently used entries until the cache fits, but never `kept`. */
	private evictFor(kept: string) {
		for (const [oldest, old] of this.entries) {
			if (this.bytes <= MAX_BYTES || oldest === kept) break;
			this.entries.delete(oldest);
			this.bytes -= size(old);
		}
	}

	forget(id: string) {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.entries.delete(id);
		this.bytes -= size(entry);
	}
}

const size = (entry: Entry) => entry.json.length + entry.brotli.length + entry.gzipBytes;
