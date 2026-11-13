import { randomUUID } from "node:crypto";
import { insertRun } from "../telemetry/store.ts";
import { searchBackend } from "./backend.ts";
import { fetchPage } from "./fetch-page.ts";
import type { WebFetchInput, WebSearchInput } from "./schema.ts";
import { withPeer } from "../tracing/http.ts";
import { span } from "../tracing/span.ts";

/**
 * web_search and web_fetch, run as durable steps by the chat workflow (workflow/steps.ts).
 * What they return is data from the web for the model, not instructions. Memory never
 * reads tool output (memory/middleware.ts), so a page cannot write to it.
 */
export const WEB_SEARCH_FUNCTION_ID = "web-search";

type Context = { threadId: string; owner: string };

export async function executeWebSearch({ query }: WebSearchInput, { threadId, owner }: Context) {
	const started = Date.now();
	const backend = searchBackend();
	try {
		// The backend and the count of results, never the query or the results.
		const reply = await span("search.query", { "ponder.search.backend": backend.name }, async (active) => {
			const found = await backend.search(query);
			active.setAttributes({ "ponder.results": found.results.length, "gen_ai.request.model": found.model });
			return found;
		});
		// Credits are charged from `runs`, so a search costs the person what it cost us.
		await insertRun({
			id: randomUUID(),
			parentId: null,
			threadId,
			user: owner,
			functionId: WEB_SEARCH_FUNCTION_ID,
			model: reply.model,
			steps: 1,
			inputTokens: reply.inputTokens,
			outputTokens: reply.outputTokens,
			cachedTokens: 0,
			costUsd: reply.costUsd,
			durationMs: Date.now() - started,
			toolCalls: [{ name: `search:${backend.name}`, status: "ok" as const }],
			finishReason: "stop",
		});
		if (!reply.results.length) return { query, results: [], error: "No results. Try other words." };
		return { query, results: reply.results.map((result, index) => ({ n: index + 1, ...result })) };
	} catch (error) {
		console.warn(`web_search (${backend.name}):`, error instanceof Error ? error.message : error);
		return { query, results: [], error: "The search failed. Try again, or answer without it and say so." };
	}
}

export async function executeWebFetch({ url }: WebFetchInput) {
	try {
		// Never the address: its path and query can carry what a prompt injection planted.
		return await span("web_fetch.read", {}, () => withPeer("web", () => fetchPage(url)));
	} catch (error) {
		// undici says only "fetch failed"; the cause names the real reason, such as a private address.
		const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
		const reason = cause instanceof Error ? cause.message : String(cause);
		return { url, error: /aborted|timeout/i.test(reason) ? "The page took too long to answer." : `Could not read the page: ${reason}` };
	}
}
