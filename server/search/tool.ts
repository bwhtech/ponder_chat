import { randomUUID } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { requestProblem } from "../runtime/Http.ts";
import { sqlMessage } from "../runtime/Database.ts";
import * as Runs from "../telemetry/Runs.ts";
import * as Tracing from "../tracing/Tracing.ts";
import * as SearchBackend from "./backend.ts";
import { fetchPage, type FetchedPage } from "./fetch-page.ts";
import type { WebFetchInput, WebSearchInput } from "./schema.ts";

/**
 * web_search and web_fetch, run as durable steps by the chat workflow (workflow/steps.ts).
 * What they return is data from the web for the model, not instructions. Memory never
 * reads tool output (memory/middleware.ts), so a page cannot write to it.
 *
 * Neither fails: a failure is an answer for the model, as before. A defect (an unknown
 * SEARCH_BACKEND) still fails the step.
 */
export const WEB_SEARCH_FUNCTION_ID = "web-search";

type Context = { threadId: string; owner: string; depth?: SearchBackend.SearchDepth };

/** `deep`: a deep search, which the page names as one (web/WebToolPart.vue). */
export type WebSearchResult = { query: string; results: ({ n: number } & SearchBackend.SearchResult)[]; error?: string; deep?: true };
export type WebFetchResult = FetchedPage | { url: string; error: string };

export const executeWebSearch = Effect.fn("WebSearch.execute")(function* ({ query }: WebSearchInput, { threadId, owner, depth = "quick" }: Context) {
	const deep = depth === "deep" ? ({ deep: true } as const) : {};
	const started = yield* Clock.currentTimeMillis;
	const backend = yield* SearchBackend.SearchBackend;
	const search = Effect.gen(function* () {
		const reply = yield* searchQuery(backend, query, depth);
		// Credits are charged from `runs`, so a search costs the person what it cost us.
		const run: Runs.RunRow = {
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
			durationMs: (yield* Clock.currentTimeMillis) - started,
			toolCalls: [{ name: `search:${backend.name}${depth === "deep" ? ":deep" : ""}`, status: "ok" as const }],
			finishReason: "stop",
		};
		yield* Runs.Runs.use((runs) => runs.insert(run));
		if (!reply.results.length) return { query, results: [], error: "No results. Try other words.", ...deep } satisfies WebSearchResult;
		return { query, results: reply.results.map((result, index) => ({ n: index + 1, ...result })), ...deep } satisfies WebSearchResult;
	});
	const failed = (problem: string) =>
		Effect.as(Effect.logWarning(`web_search (${backend.name}):`, problem), {
			query,
			results: [],
			error: "The search failed. Try again, or answer without it and say so.",
			...deep,
		} satisfies WebSearchResult);
	return yield* search.pipe(
		Effect.catchTags({
			SearchFailed: (error) => failed(error.status === undefined ? requestProblem(error.cause) : error.message),
			NoOpenRouterKey: (error) => failed(error.message),
			UnreadableSecret: (error) => failed(error.message),
			SqlError: (error) => failed(sqlMessage(error)),
		}),
	);
});

// The backend and the count of results, never the query or the results.
const searchQuery = Effect.fn("search.query")(function* (backend: SearchBackend.SearchBackend["Service"], query: string, depth: SearchBackend.SearchDepth) {
	yield* Tracing.annotate({ "ponder.search.backend": backend.name, "ponder.search.depth": depth });
	const found = yield* backend.search(query, depth);
	yield* Tracing.annotate({ "ponder.results": found.results.length, "gen_ai.request.model": found.model });
	return found;
});

export const executeWebFetch = Effect.fn("WebFetch.execute")(function* ({ url }: WebFetchInput) {
	// Never the address: its path and query can carry what a prompt injection planted.
	return yield* fetchPage(url).pipe(
		Effect.withSpan("web_fetch.read"),
		Effect.catchTags({
			PageRefused: (error) => Effect.succeed<WebFetchResult>({ url, error: `Could not read the page: ${error.message}` }),
			PageUnreachable: (error) => Effect.succeed<WebFetchResult>({ url, error: unreachable(error) }),
		}),
	);
});

/** undici says only "fetch failed"; its cause names the real reason, such as a private address. */
function unreachable(error: { timedOut: boolean; cause?: unknown }) {
	if (error.timedOut) return "The page took too long to answer.";
	const cause = error.cause instanceof Error && error.cause.cause instanceof Error ? error.cause.cause : error.cause;
	const reason = cause instanceof Error ? cause.message : String(cause);
	return /aborted|timeout/i.test(reason) ? "The page took too long to answer." : `Could not read the page: ${reason}`;
}
