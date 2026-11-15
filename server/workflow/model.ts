import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/sql/SqlError";
import { isAuto } from "../../shared/auto-model.ts";
import * as AutoRouter from "../models/AutoRouter.ts";
import { MODELS } from "../models/Models.ts";
import { HELD_BACK_TOOL_CALLS, privateRouting } from "../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import type { UnreadableSecret } from "../secrets/Secrets.ts";
import { needsCacheMarks, withCacheMarks } from "./cache.ts";

/**
 * The OpenRouter model of a reply's model calls (model-attempt.ts). Each attempt makes its
 * own, with the key that admins set (openrouter/OpenRouterKey.ts) read then, so an admin's
 * new key applies at once and the key is never part of a step's input or result.
 *
 * A service, so that a test gives a fake model in its place: OpenRouter is the outside system.
 */
export class ChatModels extends Context.Service<
	ChatModels,
	{
		readonly make: (modelId: string, threadId: string) => Effect.Effect<LanguageModelV4, OpenRouterKey.NoOpenRouterKey | UnreadableSecret | AutoRouter.NoPrivateModel | SqlError>;
	}
>()("ponder/workflow/ChatModels") {}

const make = Effect.gen(function* () {
	const key = yield* OpenRouterKey.OpenRouterKey;
	const router = yield* AutoRouter.AutoRouter;

	/**
	 * The plugins, and for Auto the session. A PDF is parsed again on every call. For a
	 * model that can't read PDFs, OpenRouter's default parser is Mistral OCR at $2 per
	 * 1,000 pages, so a chat with a few PDFs cost more in parsing than in tokens.
	 * cloudflare-ai turns the PDF into markdown for free. Auto counts as such a model,
	 * since the one it picks is known only after the call.
	 */
	const routing = Effect.fnUntraced(function* (modelId: string, threadId: string) {
		const parser = { id: "file-parser" as const, pdf: { engine: "cloudflare-ai" as const } };
		if (isAuto(modelId)) {
			// The session keeps a chat on one model where it can, so the provider's cache still holds the chat.
			return { plugins: [yield* router.plugin, parser], extraBody: { session_id: threadId } };
		}
		const readsPdf = MODELS.find((model) => model.id === modelId)?.readsPdf ?? false;
		return readsPdf ? {} : { plugins: [parser] };
	});

	return ChatModels.of({
		make: Effect.fnUntraced(function* (modelId, threadId) {
			const provider = yield* key.provider;
			const model = provider(modelId, {
				// usage.include makes OpenRouter report each call's cost, which credits are charged from.
				usage: { include: true },
				provider: { ...privateRouting, ignore: HELD_BACK_TOOL_CALLS },
				...(yield* routing(modelId, threadId)),
			}) as unknown as LanguageModelV4;
			return new ChatModel(modelId, model);
		}),
	});
});

export const layer = Layer.effect(ChatModels, make);

/**
 * OpenRouter's model, as the AI SDK sees a reply's model: provider "openrouter", the id the
 * person picked, and no URLs it reads itself, so the SDK sends each file's content. Anthropic's
 * models, which Auto may pick, cache only what the request marks (cache.ts).
 */
class ChatModel implements LanguageModelV4 {
	readonly specificationVersion = "v4";
	readonly provider = "openrouter";
	readonly supportedUrls = {};

	constructor(
		readonly modelId: string,
		private readonly openrouter: LanguageModelV4,
	) {}

	doGenerate(options: LanguageModelV4CallOptions) {
		return this.openrouter.doGenerate(this.cached(options));
	}

	doStream(options: LanguageModelV4CallOptions) {
		return this.openrouter.doStream(this.cached(options));
	}

	private cached(options: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
		return needsCacheMarks(this.modelId) ? { ...options, prompt: withCacheMarks(options.prompt) } : options;
	}
}
