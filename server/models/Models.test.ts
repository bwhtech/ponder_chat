/**
 * The models a person can pick, and Auto's choices, from a fake OpenRouter's ZDR list.
 * No database: these read no settings and no runs.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AUTO_MODEL_ID } from "../../shared/auto-model.ts";
import * as PonderConfig from "../config.ts";
import * as OpenRouter from "../openrouter/OpenRouter.ts";
import * as Database from "../runtime/Database.ts";
import * as Settings from "../settings/Settings.ts";
import * as AutoRouter from "./AutoRouter.ts";
import * as Models from "./Models.ts";

/** OpenRouter with these ZDR endpoints, or a list that can't be read (null). */
const withZdr = (endpoints: { model_id: string; context_length?: number }[] | null, env: Record<string, string> = {}) => {
	const client = HttpClient.make((request) =>
		Effect.succeed(HttpClientResponse.fromWeb(request, endpoints ? Response.json({ data: endpoints }) : new Response("down", { status: 500 }))),
	);
	return AutoRouter.layer.pipe(
		Layer.provideMerge(Models.layer),
		Layer.provide(Layer.mergeAll(OpenRouter.layer, Settings.layer)),
		Layer.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), Database.layer)),
		Layer.provide(PonderConfig.layerFromEnv(env)),
	);
};

const HAIKU = "anthropic/claude-haiku-5.5";
const GLM = "z-ai/glm-5.3";

describe("Models", () => {
	it.effect("offers Auto and the models with a private endpoint, Auto first by default", () =>
		Effect.gen(function* () {
			const models = yield* Models.Models;
			const { models: offered, defaultModel } = yield* models.available;
			assert.deepStrictEqual(
				offered.map((model) => model.id),
				[AUTO_MODEL_ID, HAIKU, GLM],
			);
			assert.strictEqual(defaultModel, AUTO_MODEL_ID);
			assert.strictEqual((yield* models.pick(GLM)).id, GLM);
			// Not on the list, or without a private endpoint: the default.
			assert.strictEqual((yield* models.pick("openai/gpt-6-luna")).id, AUTO_MODEL_ID);
			assert.strictEqual((yield* models.pick(42)).id, AUTO_MODEL_ID);
		}).pipe(Effect.provide(withZdr([{ model_id: HAIKU }, { model_id: GLM }, { model_id: "someone/else" }]))),
	);

	it.effect("starts a chat on CHAT_DEFAULT_MODEL when it can be picked", () =>
		Effect.gen(function* () {
			const models = yield* Models.Models;
			assert.strictEqual((yield* models.available).defaultModel, GLM);
			assert.strictEqual((yield* models.pick(undefined)).id, GLM);
		}).pipe(Effect.provide(withZdr([{ model_id: HAIKU }, { model_id: GLM }], { CHAT_DEFAULT_MODEL: GLM }))),
	);

	it.effect("offers nothing when no model has a private endpoint, and the whole list when the list can't be read", () =>
		Effect.gen(function* () {
			const none = yield* Models.Models.use((models) => models.available).pipe(Effect.provide(withZdr([])));
			assert.deepStrictEqual(none.models, []);
			const unknown = yield* Models.Models.use((models) => models.privateModels).pipe(Effect.provide(withZdr(null)));
			assert.strictEqual(unknown.length, Models.MODELS.length);
		}),
	);
});

describe("AutoRouter", () => {
	it.effect("names the model that answered, with or without the date OpenRouter adds", () =>
		Effect.gen(function* () {
			const router = yield* AutoRouter.AutoRouter;
			assert.deepStrictEqual(yield* router.answeringModel(`${HAIKU}-20261001`), Option.some(HAIKU));
			assert.deepStrictEqual(yield* router.answeringModel(`${GLM}-2026-10-01`), Option.some(GLM));
			assert.deepStrictEqual(yield* router.answeringModel(GLM), Option.some(GLM));
			assert.deepStrictEqual(yield* router.answeringModel("openai/gpt-6-luna"), Option.none());
			assert.deepStrictEqual(yield* router.answeringModel(undefined), Option.none());
		}).pipe(Effect.provide(withZdr([{ model_id: HAIKU }, { model_id: GLM }]))),
	);

	it.effect("gives Auto the smallest window of the models it may pick", () =>
		Effect.gen(function* () {
			const router = yield* AutoRouter.AutoRouter;
			assert.deepStrictEqual(yield* router.modelWindow(HAIKU), Option.some(200_000));
			assert.deepStrictEqual(yield* router.modelWindow(AUTO_MODEL_ID), Option.some(128_000));
		}).pipe(Effect.provide(withZdr([{ model_id: HAIKU, context_length: 200_000 }, { model_id: GLM, context_length: 128_000 }]))),
	);
});
