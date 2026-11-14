import { isAuto } from "../shared/auto-model.ts";
import { privateModels } from "./models.ts";
import { contextWindow } from "./openrouter.ts";
import { getSettings } from "./settings.ts";

/**
 * OpenRouter's Auto Router (openrouter/auto). For each call it rates the request and
 * picks a model and a reasoning effort, weighed against price and benchmarks. Its
 * settings go in the `auto-router` plugin:
 * - `allowed_models`: only the models on Ponder's list with a private (ZDR) endpoint,
 *   so Auto never runs a model a person could not pick.
 * - `cost_tier`: how much it may spend on a request, set by admins (settings.ts).
 * See https://openrouter.ai/docs/guides/routing/routers/auto-router.
 */
export async function autoRouterPlugin() {
	const [models, { autoCostTier }] = await Promise.all([privateModels(), getSettings()]);
	return { id: "auto-router" as const, allowed_models: models.map((model) => model.id), cost_tier: autoCostTier };
}

/**
 * A model's context window. For Auto, the smallest of the models it may pick, since
 * the model that answers is known only after the call.
 */
export async function modelWindow(modelId: string): Promise<number | undefined> {
	if (!isAuto(modelId)) return contextWindow(modelId);
	const windows = await Promise.all((await privateModels()).map((model) => contextWindow(model.id)));
	const known = windows.filter((window): window is number => window !== undefined);
	return known.length ? Math.min(...known) : undefined;
}
