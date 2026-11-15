import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AUTO_MODEL_ID } from "../../shared/auto-model.ts";
import * as PonderConfig from "../config.ts";
import * as OpenRouter from "../openrouter/OpenRouter.ts";

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
 * reasoning effort (AutoRouter.ts). The model that answered is known only after the call.
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

/** What a person can pick, and the one a chat starts on when they have not picked: GET /api/models. */
export type Pickable = { models: ChatModel[]; defaultModel: string };

export class Models extends Context.Service<
	Models,
	{
		/**
		 * What a person can pick: Auto, then the models with a private endpoint. Auto shows
		 * only when at least one of them does, since it picks only from them.
		 */
		readonly available: Effect.Effect<Pickable>;
		/**
		 * The same, without waiting for OpenRouter, for the chat page's first screen (boot-page.ts).
		 * None until OpenRouter's list has been read once since the start.
		 */
		readonly cached: Effect.Effect<Option.Option<Pickable>>;
		/** The model to run: the one asked for if it is available, else the default. */
		readonly pick: (id: unknown) => Effect.Effect<ChatModel>;
		/**
		 * The models on the list that have a Zero Data Retention endpoint on OpenRouter: the
		 * only ones a person can run, since every call asks for ZDR (openrouter/OpenRouter.ts),
		 * and the only ones Auto may pick. When OpenRouter's list can't be read, the whole list
		 * shows; a model without ZDR then fails with an error, and still never reaches a
		 * provider that keeps data.
		 */
		readonly privateModels: Effect.Effect<ChatModel[]>;
	}
>()("ponder/models/Models") {}

const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const openRouter = yield* OpenRouter.OpenRouter;

	const withZdr = (zdr: Option.Option<ReadonlySet<string>>) =>
		Option.match(zdr, { onNone: () => MODELS, onSome: (ids) => MODELS.filter((model) => ids.has(model.id)) });

	const pickable = (named: ChatModel[]): Pickable => {
		const models = named.length ? [AUTO_MODEL, ...named] : [];
		const fallback = models.find((model) => model.id === config.defaultModel) ?? models[0] ?? AUTO_MODEL;
		return { models, defaultModel: fallback.id };
	};

	const privateModels = Effect.map(openRouter.modelsWithZdr, withZdr);
	const available = Effect.map(privateModels, pickable);
	const cached = Effect.map(openRouter.modelsWithZdrNow, Option.map((zdr) => pickable(withZdr(Option.some(zdr)))));

	const pick = Effect.fn("Models.pick")(function* (id: unknown) {
		const { models, defaultModel } = yield* available;
		return models.find((model) => model.id === id) ?? [AUTO_MODEL, ...MODELS].find((model) => model.id === defaultModel) ?? AUTO_MODEL;
	});

	return Models.of({ available, cached, pick, privateModels });
});

export const layer = Layer.effect(Models, make);
