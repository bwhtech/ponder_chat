/**
 * The models a person can pick in the chat, all through OpenRouter. A short list on
 * purpose: one cheap default, and a few strong models from each lab. The browser
 * gets this list from GET /api/models; a request for any other id falls back to the
 * default, so the list is also the allowlist.
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
};

export const MODELS: ChatModel[] = [
	{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "DeepSeek", description: "Fast and cheap. The default." },
	{ id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", provider: "Anthropic", description: "Fast, low cost" },
	{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "Anthropic", description: "Strong all-rounder" },
	{ id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", provider: "Anthropic", description: "Most capable. Uses credits fastest." },
	{ id: "openai/gpt-6-luna", name: "GPT-6 Luna", provider: "OpenAI", description: "Fast, low cost" },
	{ id: "openai/gpt-6.1-terra", name: "GPT-6.1 Terra", provider: "OpenAI", description: "Strong all-rounder" },
	{ id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "Google", description: "Fast, long context" },
	{ id: "google/gemini-4-argon", name: "Gemini 4 Argon", provider: "Google", description: "Most capable Gemini" },
	{ id: "x-ai/grok-4.7", name: "Grok 4.7", provider: "xAI", description: "Strong all-rounder" },
	{ id: "moonshotai/kimi-k3.1-pro", name: "Kimi K3.1 Pro", provider: "Moonshot", description: "Strong at long tasks" },
	{ id: "qwen/qwen3.8-flash", name: "Qwen3.8 Flash", provider: "Qwen", description: "Fast and cheap" },
	{ id: "z-ai/glm-5.3", name: "GLM 5.3", provider: "Z.ai", description: "Open weights, low input cost" },
];

export const DEFAULT_MODEL = process.env.CHAT_DEFAULT_MODEL ?? MODELS[0].id;

/** The model to run: the one asked for if it is on the list, else the default. */
export function pickModel(id: unknown): ChatModel {
	return MODELS.find((model) => model.id === id) ?? MODELS.find((model) => model.id === DEFAULT_MODEL) ?? MODELS[0];
}
