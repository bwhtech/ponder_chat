import { privateRoutingBody } from "../openrouter.ts";
import { openRouterKey } from "../openrouter-key.ts";
import type { SearchBackend, SearchReply, SearchResult } from "./backend.ts";

/**
 * Searches with OpenRouter's web_search server tool, so it needs no other API key.
 * The tool runs only inside a model call, so a cheap model makes one search and its
 * `url_citation` annotations are the results. The chat model never sees this tool.
 * OpenRouter's `cost` includes the search fee ($0.007 for Exa).
 *
 * Calls Chat Completions directly, so the annotations come back as OpenRouter sends them.
 */
const URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.PONDER_SEARCH_MODEL ?? "z-ai/glm-5.3-flash";
const MAX_RESULTS = 6;
const MAX_TEXT = 3_000;
const TIMEOUT_MS = 45_000;

type Citation = { url?: string; title?: string; content?: string };
type Completion = {
	error?: { message?: string };
	model?: string;
	choices?: { message?: { annotations?: { type: string; url_citation?: Citation }[] } }[];
	usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
};

export class OpenRouterSearch implements SearchBackend {
	readonly name = "openrouter";

	async search(query: string): Promise<SearchReply> {
		const body = await this.complete(query);
		return {
			results: this.results(body),
			costUsd: body.usage?.cost ?? null,
			model: body.model ?? MODEL,
			inputTokens: body.usage?.prompt_tokens ?? 0,
			outputTokens: body.usage?.completion_tokens ?? 0,
		};
	}

	private async complete(query: string): Promise<Completion> {
		const response = await fetch(URL, {
			method: "POST",
			headers: { authorization: `Bearer ${await openRouterKey()}`, "content-type": "application/json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
			body: JSON.stringify({
				model: MODEL,
				messages: [
					{ role: "system", content: "Search the web once for the user's query, with the query as written. Then reply with only: done." },
					{ role: "user", content: query },
				],
				tools: [{ type: "openrouter:web_search", parameters: { engine: "exa", max_results: MAX_RESULTS, max_uses: 1 } }],
				provider: privateRoutingBody,
				usage: { include: true },
			}),
		});
		const body = (await response.json().catch(() => ({}))) as Completion;
		if (!response.ok || body.error) throw new Error(`OpenRouter search failed (${response.status}): ${body.error?.message ?? "no reply"}`);
		return body;
	}

	private results(body: Completion): SearchResult[] {
		const seen = new Set<string>();
		const results: SearchResult[] = [];
		for (const annotation of body.choices?.[0]?.message?.annotations ?? []) {
			const citation = annotation.url_citation;
			if (annotation.type !== "url_citation" || !citation?.url || seen.has(citation.url)) continue;
			seen.add(citation.url);
			results.push({ title: citation.title ?? citation.url, url: citation.url, text: (citation.content ?? "").slice(0, MAX_TEXT) });
		}
		return results;
	}
}
