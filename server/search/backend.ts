import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as PonderConfig from "../config.ts";
import type { NoOpenRouterKey } from "../openrouter/OpenRouterKey.ts";
import type { UnreadableSecret } from "../secrets/Secrets.ts";
import * as OpenRouterSearch from "./openrouter-search.ts";

/**
 * Where web_search gets its results. The model sees only our own tool (schema.ts), so a
 * backend can change without changing what any model is told. Pick one with SEARCH_BACKEND.
 *
 * Later, for more privacy: OpenRouter's search engines (Exa and others) keep queries by
 * their own rules; ZDR covers only the model call. Options are a search API with a
 * contract for zero data retention (Brave, Exa or Parallel enterprise) or a SearXNG we
 * host. Each is one more entry in BACKENDS.
 */
export type SearchResult = { title: string; url: string; text: string };

/** One search: its results, and what it cost, so credits are charged for it. */
export type SearchReply = { results: SearchResult[]; costUsd: number | null; model: string; inputTokens: number; outputTokens: number };

/**
 * The backend did not answer with results: its HTTP status, or none when it could not be
 * reached or took too long (the cause). Never its answer, which can hold the query.
 */
export class SearchFailed extends Schema.TaggedError<SearchFailed>()("SearchFailed", {
	backend: Schema.String,
	status: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		return this.status === undefined ? `The ${this.backend} search failed.` : `The ${this.backend} search failed (${this.status}).`;
	}
}

export class SearchBackend extends Context.Service<
	SearchBackend,
	{
		readonly name: string;
		readonly search: (query: string) => Effect.Effect<SearchReply, SearchFailed | NoOpenRouterKey | UnreadableSecret | SqlError>;
	}
>()("ponder/search/SearchBackend") {}

// Functions, so neither module reads the other while they load (openrouter-search.ts imports SearchFailed).
const BACKENDS: Record<string, () => Effect.Effect<SearchBackend["Service"], never, OpenRouterSearch.Requires>> = {
	openrouter: () => OpenRouterSearch.make,
};

/**
 * The backend that SEARCH_BACKEND names. An unknown name does not stop the server from
 * starting: each search fails with it, as a defect, as it did before.
 */
export const layer = Layer.effect(
	SearchBackend,
	Effect.gen(function* () {
		const { searchBackend: name } = yield* PonderConfig.PonderConfig;
		const make = BACKENDS[name];
		if (make) return yield* make();
		const unknown = new Error(`SEARCH_BACKEND "${name}" is not one of: ${Object.keys(BACKENDS).join(", ")}`);
		return SearchBackend.of({ name, search: () => Effect.die(unknown) });
	}),
);
