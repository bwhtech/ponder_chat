import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { needsCacheMarks, withCacheMarks } from "./cache.ts";

/**
 * The OpenRouter model of a reply's model calls (model-attempt.ts). It keeps only the
 * model id, and reads the key (openrouter-key.ts) for each call, so an admin's new key
 * applies at once and the key is never part of a step's input or result.
 */
export class ChatModel implements LanguageModelV4 {
	readonly specificationVersion = "v4";
	readonly provider = "openrouter";
	readonly supportedUrls = {};

	constructor(readonly modelId: string) {}

	// Called only inside model steps, which run in plain Node.
	async doGenerate(options: LanguageModelV4CallOptions) {
		return (await this.openrouter()).doGenerate(this.cached(options));
	}

	async doStream(options: LanguageModelV4CallOptions) {
		return (await this.openrouter()).doStream(this.cached(options));
	}

	/** Anthropic's models cache only what the request marks (cache.ts). */
	private cached(options: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
		return needsCacheMarks(this.modelId) ? { ...options, prompt: withCacheMarks(options.prompt) } : options;
	}

	private async openrouter(): Promise<LanguageModelV4> {
		const { MODELS } = await import("../models.ts");
		const { HELD_BACK_TOOL_CALLS, privateRouting } = await import("../openrouter.ts");
		// A PDF is parsed again on every call. For a model that can't read PDFs, OpenRouter's
		// default parser is Mistral OCR at $2 per 1,000 pages, so a chat with a few PDFs cost
		// more in parsing than in tokens. cloudflare-ai turns the PDF into markdown for free.
		const readsPdf = MODELS.find((model) => model.id === this.modelId)?.readsPdf ?? false;
		return (await openRouterProvider())(this.modelId, {
			// usage.include makes OpenRouter report each call's cost, which credits are charged from.
			usage: { include: true },
			provider: { ...privateRouting, ignore: HELD_BACK_TOOL_CALLS },
			...(!readsPdf && { plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }] }),
		}) as unknown as LanguageModelV4;
	}
}

/**
 * OpenRouter with the key admins set (openrouter-key.ts), which reads Postgres. A step
 * only so that the workflow bundle leaves out its imports: it is called inside the model
 * step, where a step runs as a plain function. It returns the provider and not the key,
 * so the key can never be saved as a step's result.
 */
async function openRouterProvider() {
	"use step";
	const { openRouter } = await import("../openrouter-key.ts");
	return openRouter();
}
