import { isAuto } from "../shared/auto-model.ts";
import { sql } from "./db.ts";
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
	// OpenRouter reads an empty list as every model, so Auto does not run without one.
	if (!models.length) throw new Error("No model has a private endpoint now, so Auto can't run. Try again later.");
	return { id: "auto-router" as const, allowed_models: models.map((model) => model.id), cost_tier: autoCostTier };
}

/**
 * The model on the list that answered an Auto call, from the id OpenRouter reports,
 * which may end in a date ("…-20261001"). Undefined when it is not on the list.
 */
export async function answeringModel(reported: string | undefined): Promise<string | undefined> {
	if (!reported) return undefined;
	const ids = new Set((await privateModels()).map((model) => model.id));
	const undated = reported.replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, "");
	return [reported, undated].find((id) => ids.has(id));
}

/**
 * The model that answered the thread's last finished model call (`runs`, model-calls.ts),
 * for a run that carries on that reply after an approval (replies.ts).
 */
export async function lastAnsweringModel(threadId: string): Promise<string | undefined> {
	const [row] = await sql<{ model: string }[]>`
		select model from runs where thread_id = ${threadId} and function_id = 'chat' and finish_reason <> 'started'
		order by created_at desc limit 1`;
	return answeringModel(row?.model);
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
