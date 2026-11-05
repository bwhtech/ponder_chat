import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

/**
 * The OpenRouter model, made safe to cross workflow step boundaries, from the platform's
 * spike (platform/server/workflow/model.ts).
 *
 * WorkflowAgent passes its model into each durable model step, so the model is
 * serialized into Postgres. OpenRouter's model class is not serializable, and
 * providers that are serialize their config, API key headers included. This class
 * keeps only the model id, and reads the key from the environment in the step.
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
		const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
		const { MODELS } = await import("../models.ts");
		// A PDF is parsed again on every call. For a model that can't read PDFs, OpenRouter's
		// default parser is Mistral OCR at $2 per 1,000 pages, so a chat with a few PDFs cost
		// more in parsing than in tokens. cloudflare-ai turns the PDF into markdown for free.
		const readsPdf = MODELS.find((model) => model.id === this.modelId)?.readsPdf ?? false;
		return createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })(this.modelId, {
			// usage.include makes OpenRouter report each call's cost, which credits are charged from.
			usage: { include: true },
			...(!readsPdf && { plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }] }),
		}) as unknown as LanguageModelV4;
	}
}
