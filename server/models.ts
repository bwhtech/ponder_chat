import { AUTO_MODEL_ID } from "../shared/auto-model.ts";
import { modelsWithZdr, modelsWithZdrNow } from "./openrouter.ts";

/**
 * The models a person can pick in the chat, all through OpenRouter. A short list on
 * purpose: Auto, which is the default, and a few strong models from each lab. The
 * browser gets this list from GET /api/models; a request for any other id falls back
 * to the default, so the list is also the allowlist.
 *
 * Prices are OpenRouter's, in USD per million tokens, for the selector only. Credits
 * are charged from the cost OpenRouter reports for each call (credits.ts), not from these.
 */
export type ChatModel = {
	id: string;
	name: string;
	provider: string;
	/** Shown under the name in the selector. */
	description: string;
	/**
	 * Whether the model reads PDFs itself (OpenRouter input modality "file"). For the
	 * others OpenRouter parses each PDF on every call, and its default parser is paid
	 * OCR, so they get the free text parser instead (workflow/model.ts).
	 */
	readsPdf: boolean;
};

/**
 * OpenRouter's Auto Router: for each call it picks one of the models below and a
 * reasoning effort (auto-router.ts). The model that answered is known only after the call.
 */
export const AUTO_MODEL: ChatModel = {
	id: AUTO_MODEL_ID,
	name: "Auto",
	provider: "OpenRouter",
	description: "Picks a model for each message. The default.",
	readsPdf: false,
};

export const MODELS: ChatModel[] = [
	{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "DeepSeek", description: "Fast and cheap", readsPdf: false },
	{ id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", provider: "Anthropic", description: "Fast, low cost", readsPdf: true },
	{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "Anthropic", description: "Strong all-rounder", readsPdf: true },
	{ id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", provider: "Anthropic", description: "Most capable. Uses credits fastest.", readsPdf: true },
	{ id: "openai/gpt-6-luna", name: "GPT-6 Luna", provider: "OpenAI", description: "Fast, low cost", readsPdf: true },
	{ id: "openai/gpt-6.1-terra", name: "GPT-6.1 Terra", provider: "OpenAI", description: "Strong all-rounder", readsPdf: true },
	{ id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "Google", description: "Fast, long context", readsPdf: true },
	{ id: "google/gemini-4-argon", name: "Gemini 4 Argon", provider: "Google", description: "Most capable Gemini", readsPdf: true },
	{ id: "x-ai/grok-4.7", name: "Grok 4.7", provider: "xAI", description: "Strong all-rounder", readsPdf: true },
	{ id: "moonshotai/kimi-k3.1-pro", name: "Kimi K3.1 Pro", provider: "Moonshot", description: "Strong at long tasks", readsPdf: false },
	{ id: "qwen/qwen3.8-flash", name: "Qwen3.8 Flash", provider: "Qwen", description: "Fast and cheap", readsPdf: false },
	{ id: "z-ai/glm-5.3", name: "GLM 5.3", provider: "Z.ai", description: "Open weights, low input cost", readsPdf: false },
];

const DEFAULT_MODEL = process.env.CHAT_DEFAULT_MODEL ?? AUTO_MODEL.id;

/**
 * What a person can pick: Auto, then the models with a private endpoint. Auto shows
 * only when at least one of them does, since it picks only from them.
 */
export async function availableModels() {
	return pickable(withZdr(await modelsWithZdr()));
}

/**
 * The same, without waiting for OpenRouter, for the chat page's first screen (boot-page.ts).
 * Undefined until OpenRouter's list has been read once since the start.
 */
export function cachedModels() {
	const zdr = modelsWithZdrNow();
	return zdr && pickable(withZdr(zdr));
}

function pickable(named: ChatModel[]) {
	const models = named.length ? [AUTO_MODEL, ...named] : [];
	const fallback = models.find((model) => model.id === DEFAULT_MODEL) ?? models[0] ?? AUTO_MODEL;
	return { models, defaultModel: fallback.id };
}

/** The model to run: the one asked for if it is available, else the default. */
export async function pickModel(id: unknown): Promise<ChatModel> {
	const { models, defaultModel } = await availableModels();
	return models.find((model) => model.id === id) ?? [AUTO_MODEL, ...MODELS].find((model) => model.id === defaultModel) ?? AUTO_MODEL;
}

/**
 * The models on the list that have a Zero Data Retention endpoint on OpenRouter: the
 * only ones a person can run, since every call asks for ZDR (openrouter.ts), and the
 * only ones Auto may pick. When OpenRouter's list can't be read, the whole list shows;
 * a model without ZDR then fails with an error, and still never reaches a provider
 * that keeps data.
 */
export async function privateModels() {
	return withZdr(await modelsWithZdr());
}

function withZdr(zdr: Set<string> | undefined) {
	return zdr ? MODELS.filter((model) => zdr.has(model.id)) : MODELS;
}
