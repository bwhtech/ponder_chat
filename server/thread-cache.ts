import { gzipSync } from "node:zlib";
import type { Context } from "hono";
import { loadThread, threadUpdatedAt } from "./db.ts";
import { activeRun } from "./workflow/runs.ts";

/**
 * GET /api/threads/:id, cached. A thread's version is its updated_at plus whether a
 * reply is running, so the page revalidates with If-None-Match and gets a 304 when
 * nothing changed. Otherwise the response body, and its gzip, come from memory while
 * the version holds: a long thread is close to 1 MB of JSON and about a tenth of
 * that gzipped.
 */
type Entry = { etag: string; json: string; gzip: Buffer };

const entries = new Map<string, Entry>();
const MAX_BYTES = 64 * 1024 * 1024;
let bytes = 0;

export async function threadResponse(c: Context, id: string, owner: string) {
	const updatedAt = await threadUpdatedAt(id, owner);
	const running = Boolean(await activeRun(id));
	// A thread not saved yet (or someone else's) has no version: always fresh, never cached.
	if (!updatedAt) return c.json({ messages: [], running: false }, 200, { "Cache-Control": "no-store" });

	const etag = `"${updatedAt.getTime()}${running ? "-running" : ""}"`;
	const headers = { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Accept-Encoding" };
	if (c.req.header("If-None-Match")?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) return c.body(null, 304, headers);

	const entry = cached(id, etag) ?? remember(id, etag, JSON.stringify({ messages: await loadThread(id), running }));
	if (/\bgzip\b/.test(c.req.header("Accept-Encoding") ?? "")) {
		return c.body(new Uint8Array(entry.gzip), 200, { ...headers, "Content-Type": "application/json", "Content-Encoding": "gzip" });
	}
	return c.body(entry.json, 200, { ...headers, "Content-Type": "application/json" });
}

/** Drops a deleted thread. A saved one needs nothing: its new version misses the cache. */
export function forgetThread(id: string) {
	const entry = entries.get(id);
	if (!entry) return;
	entries.delete(id);
	bytes -= size(entry);
}

function cached(id: string, etag: string) {
	const entry = entries.get(id);
	if (entry?.etag !== etag) return undefined;
	// Most recently used goes last; the first is evicted first.
	entries.delete(id);
	entries.set(id, entry);
	return entry;
}

function remember(id: string, etag: string, json: string) {
	forgetThread(id);
	const entry = { etag, json, gzip: gzipSync(json) };
	entries.set(id, entry);
	bytes += size(entry);
	for (const [oldest, old] of entries) {
		if (bytes <= MAX_BYTES || oldest === id) break;
		entries.delete(oldest);
		bytes -= size(old);
	}
	return entry;
}

const size = (entry: Entry) => entry.json.length + entry.gzip.length;
