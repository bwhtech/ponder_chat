import { OpenRouterSearch } from "./openrouter-search.ts";

/**
 * Where web_search gets its results. The model sees only our own tool (schema.ts), so a
 * backend can change without changing what any model is told. Pick one with SEARCH_BACKEND.
 *
 * Later, for more privacy: OpenRouter's search engines (Exa and others) keep queries by
 * their own rules; ZDR covers only the model call. Options are a search API with a
 * contract for zero data retention (Brave, Exa or Parallel enterprise) or a SearXNG we
 * host. Each is one more class here.
 */
export type SearchResult = { title: string; url: string; text: string };

/** One search: its results, and what it cost, so credits are charged for it. */
export type SearchReply = { results: SearchResult[]; costUsd: number | null; model: string; inputTokens: number; outputTokens: number };

export interface SearchBackend {
	readonly name: string;
	search(query: string): Promise<SearchReply>;
}

const BACKENDS: Record<string, () => SearchBackend> = {
	openrouter: () => new OpenRouterSearch(),
};

export function searchBackend(): SearchBackend {
	const name = process.env.SEARCH_BACKEND ?? "openrouter";
	const make = BACKENDS[name];
	if (!make) throw new Error(`SEARCH_BACKEND "${name}" is not one of: ${Object.keys(BACKENDS).join(", ")}`);
	return make();
}
