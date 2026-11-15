import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { isAuto } from "../../shared/auto-model.ts";
import * as OpenRouter from "../openrouter/OpenRouter.ts";
import * as Settings from "../settings/Settings.ts";
import * as Models from "./Models.ts";

/**
 * OpenRouter's Auto Router (openrouter/auto). For each call it rates the request and
 * picks a model and a reasoning effort, weighed against price and benchmarks. Its
 * settings go in the `auto-router` plugin:
 * - `allowed_models`: only the models on Ponder's list with a private (ZDR) endpoint,
 *   so Auto never runs a model a person could not pick.
 * - `cost_tier`: how much it may spend on a request, set by admins (settings/Settings.ts).
 * See https://openrouter.ai/docs/guides/routing/routers/auto-router.
 */

/** No model on the list has a private endpoint now. */
export class NoPrivateModel extends Schema.TaggedError<NoPrivateModel>()("NoPrivateModel", {}) {
	override get message() {
		return "No model has a private endpoint now, so Auto can't run. Try again later.";
	}
}

export type AutoRouterPlugin = { id: "auto-router"; allowed_models: string[]; cost_tier: Settings.AutoCostTier };

export class AutoRouter extends Context.Service<
	AutoRouter,
	{
		/** The `auto-router` plugin for an Auto call. */
		readonly plugin: Effect.Effect<AutoRouterPlugin, NoPrivateModel | SqlError>;
		/**
		 * The model on the list that answered an Auto call, from the id OpenRouter reports,
		 * which may end in a date ("…-20261001"). None when it is not on the list.
		 */
		readonly answeringModel: (reported: string | undefined) => Effect.Effect<Option.Option<string>>;
		/**
		 * The model that answered the thread's last finished model call (`runs`, telemetry/ModelCalls.ts),
		 * for a run that carries on that reply after an approval (workflow/replies.ts).
		 */
		readonly lastAnsweringModel: (threadId: string) => Effect.Effect<Option.Option<string>, SqlError>;
		/**
		 * A model's context window. For Auto, the smallest of the models it may pick, since
		 * the model that answers is known only after the call.
		 */
		readonly modelWindow: (modelId: string) => Effect.Effect<Option.Option<number>>;
	}
>()("ponder/models/AutoRouter") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const models = yield* Models.Models;
	const settings = yield* Settings.Settings;
	const openRouter = yield* OpenRouter.OpenRouter;

	const plugin = Effect.gen(function* () {
		const [named, { autoCostTier }] = yield* Effect.all([models.privateModels, settings.get], { concurrency: "unbounded" });
		// OpenRouter reads an empty list as every model, so Auto does not run without one.
		if (!named.length) return yield* new NoPrivateModel();
		return { id: "auto-router" as const, allowed_models: named.map((model) => model.id), cost_tier: autoCostTier };
	}).pipe(Effect.withSpan("AutoRouter.plugin"));

	const answeringModel = Effect.fn("AutoRouter.answeringModel")(function* (reported: string | undefined) {
		if (!reported) return Option.none<string>();
		const ids = new Set((yield* models.privateModels).map((model) => model.id));
		const undated = reported.replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, "");
		return Option.fromUndefinedOr([reported, undated].find((id) => ids.has(id)));
	});

	const findLastModel = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: Schema.Struct({ model: Schema.String }),
		execute: (threadId) => sql`
			select model from runs where thread_id = ${threadId} and function_id = 'chat' and finish_reason <> 'started'
			order by created_at desc limit 1`,
	});

	const lastAnsweringModel = Effect.fn("AutoRouter.lastAnsweringModel")(function* (threadId: string) {
		const row = yield* findLastModel(threadId).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return yield* answeringModel(Option.getOrUndefined(Option.map(row, (found) => found.model)));
	});

	const modelWindow = Effect.fn("AutoRouter.modelWindow")(function* (modelId: string) {
		if (!isAuto(modelId)) return yield* openRouter.contextWindow(modelId);
		const windows = yield* Effect.forEach(yield* models.privateModels, (model) => openRouter.contextWindow(model.id), { concurrency: "unbounded" });
		const known = windows.flatMap((window) => Option.toArray(window));
		return known.length ? Option.some(Math.min(...known)) : Option.none<number>();
	});

	return AutoRouter.of({ plugin, answeringModel, lastAnsweringModel, modelWindow });
});

export const layer = Layer.effect(AutoRouter, make);
