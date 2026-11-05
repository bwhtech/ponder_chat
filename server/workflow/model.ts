import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

/**
 * The OpenRouter model, made safe to cross workflow step boundaries, from the platform's
 * spike (platform/server/workflow/model.ts).
 *
 * WorkflowAgent passes its model into each durable model step, so the model is
 * serialized into Postgres. OpenRouter's model class is not serializable, and
 * providers that are serialize their config, API key headers included. This class
 * keeps only the model id, and reads the key (openrouter-key.ts) in the step.
 */
export class ChatModel implements LanguageModelV4 {
	readonly specificationVersion = "v4";
	readonly provider = "openrouter";
	readonly supportedUrls = {};

	constructor(readonly modelId: string) {}

	static [WORKFLOW_SERIALIZE](model: ChatModel) {
		return { modelId: model.modelId };
	}

	static [WORKFLOW_DESERIALIZE](data: { modelId: string }) {
		return new ChatModel(data.modelId);
	}

	// Called only inside model steps, which run in plain Node.
	async doGenerate(options: LanguageModelV4CallOptions) {
		return (await this.openrouter()).doGenerate(options);
	}

	async doStream(options: LanguageModelV4CallOptions) {
		return (await this.openrouter()).doStream(options);
	}

	private async openrouter(): Promise<LanguageModelV4> {
		const { MODELS } = await import("../models.ts");
		const { privateRouting } = await import("../openrouter.ts");
		// A PDF is parsed again on every call. For a model that can't read PDFs, OpenRouter's
		// default parser is Mistral OCR at $2 per 1,000 pages, so a chat with a few PDFs cost
		// more in parsing than in tokens. cloudflare-ai turns the PDF into markdown for free.
		const readsPdf = MODELS.find((model) => model.id === this.modelId)?.readsPdf ?? false;
		return (await openRouterProvider())(this.modelId, {
			// usage.include makes OpenRouter report each call's cost, which credits are charged from.
			usage: { include: true },
			provider: privateRouting,
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
