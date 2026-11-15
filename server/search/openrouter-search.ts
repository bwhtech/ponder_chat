import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as PonderConfig from "../config.ts";
import * as OpenRouter from "../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import { SearchFailed, type SearchBackend, type SearchReply, type SearchResult } from "./backend.ts";

/**
 * Searches with OpenRouter's web_search server tool, so it needs no other API key.
 * The tool runs only inside a model call, so a cheap model makes one search and its
 * `url_citation` annotations are the results. The chat model never sees this tool.
 * OpenRouter's `cost` includes the search fee ($0.007 for Exa).
 *
 * Calls Chat Completions directly, so the annotations come back as OpenRouter sends them.
 * The model is PONDER_SEARCH_MODEL.
 */
const NAME = "openrouter";
const MAX_RESULTS = 6;
const MAX_TEXT = 3_000;
const TIMEOUT = "45 seconds";

/** Lenient: a field OpenRouter leaves out, or sends as null, changes nothing. */
const text = Schema.optional(Schema.NullOr(Schema.String));
const count = Schema.optional(Schema.NullOr(Schema.Number));
const Citation = Schema.Struct({ url: text, title: text, content: text });
const Completion = Schema.Struct({
	error: Schema.optional(Schema.NullOr(Schema.Struct({ message: text }))),
	model: text,
	choices: Schema.optional(
		Schema.NullOr(
			Schema.Array(
				Schema.Struct({
					message: Schema.optional(
						Schema.NullOr(Schema.Struct({ annotations: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ type: Schema.String, url_citation: Schema.optional(Schema.NullOr(Citation)) })))) })),
					),
				}),
			),
		),
	),
	usage: Schema.optional(Schema.NullOr(Schema.Struct({ cost: count, prompt_tokens: count, completion_tokens: count }))),
});
type Completion = typeof Completion.Type;
const decodeCompletion = Schema.decodeUnknownOption(Completion);

export type Requires = PonderConfig.PonderConfig | OpenRouter.OpenRouter | OpenRouterKey.OpenRouterKey | HttpClient.HttpClient;

export const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const openRouter = yield* OpenRouter.OpenRouter;
	const keys = yield* OpenRouterKey.OpenRouterKey;
	const client = yield* HttpClient.HttpClient;
	const model = config.searchModel;
	const failed = (cause: unknown) => new SearchFailed({ backend: NAME, cause });

	const complete = Effect.fnUntraced(function* (query: string) {
		const request = HttpClientRequest.post(openRouter.url("v1/chat/completions")).pipe(
			HttpClientRequest.bearerToken(yield* keys.key),
			HttpClientRequest.bodyJsonUnsafe({
				model,
				messages: [
					{ role: "system", content: "Search the web once for the user's query, with the query as written. Then reply with only: done." },
					{ role: "user", content: query },
				],
				tools: [{ type: "openrouter:web_search", parameters: { engine: "exa", max_results: MAX_RESULTS, max_uses: 1 } }],
				provider: OpenRouter.privateRoutingBody,
				usage: { include: true },
			}),
		);
		// The timeout covers the answer and the reading of its body.
		const { status, body } = yield* Effect.gen(function* () {
			const response = yield* client.execute(request);
			const json = yield* response.json.pipe(Effect.option);
			return { status: response.status, body: Option.getOrElse(Option.flatMap(json, decodeCompletion), (): Completion => ({})) };
		}).pipe(Effect.timeout(TIMEOUT), Effect.catchTags({ HttpClientError: (error) => Effect.fail(failed(error.reason.cause)), TimeoutError: (error) => Effect.fail(failed(error)) }));
		if (status < 200 || status >= 300 || body.error) return yield* new SearchFailed({ backend: NAME, status });
		return body;
	});

	const search = Effect.fn("OpenRouterSearch.search")(function* (query: string) {
		const body = yield* complete(query);
		return {
			results: results(body),
			costUsd: body.usage?.cost ?? null,
			model: body.model ?? model,
			inputTokens: body.usage?.prompt_tokens ?? 0,
			outputTokens: body.usage?.completion_tokens ?? 0,
		} satisfies SearchReply;
	});

	return { name: NAME, search } satisfies SearchBackend["Service"];
});

function results(body: Completion): SearchResult[] {
	const seen = new Set<string>();
	const found: SearchResult[] = [];
	for (const annotation of body.choices?.[0]?.message?.annotations ?? []) {
		const citation = annotation.url_citation;
		if (annotation.type !== "url_citation" || !citation?.url || seen.has(citation.url)) continue;
		seen.add(citation.url);
		found.push({ title: citation.title ?? citation.url, url: citation.url, text: (citation.content ?? "").slice(0, MAX_TEXT) });
	}
	return found;
}
