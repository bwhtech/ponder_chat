/**
 * OpenRouter's list of private (ZDR) endpoints and the key check, against a fake
 * OpenRouter: an HttpClient that answers in the test. No database: the key check reads
 * no secret, and the pool opens a connection only when a query needs one.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as PonderConfig from "../config.ts";
import * as Database from "../runtime/Database.ts";
import * as Secrets from "../secrets/Secrets.ts";
import * as OpenRouter from "./OpenRouter.ts";
import * as OpenRouterKey from "./OpenRouterKey.ts";

type Answer = (request: HttpClientRequest.HttpClientRequest, url: URL) => Effect.Effect<Response, HttpClientError.HttpClientError>;

/** A fake OpenRouter: each request goes to `answer`, and is kept in `requests`. */
function fakeOpenRouter(answer: Answer) {
	const requests: { url: URL; authorization: string | undefined }[] = [];
	const client = HttpClient.make((request, url) => {
		requests.push({ url, authorization: request.headers.authorization });
		return Effect.map(answer(request, url), (response) => HttpClientResponse.fromWeb(request, response));
	});
	return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) };
}

/** The log lines, as Ponder's logger prints them (tracing/Logger.ts). */
function capturedLogs() {
	const lines: string[] = [];
	const logger = Logger.make(({ message }) => lines.push((Array.isArray(message) ? message : [message]).join(" ")));
	return { lines, layer: Logger.layer([logger]) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ZDR_LIST = {
	data: [
		{ model_id: "anthropic/claude-haiku-5.5", provider_name: "Anthropic", context_length: 200_000 },
		{ model_id: "anthropic/claude-haiku-5.5", provider_name: "Amazon Bedrock", context_length: 180_000 },
		// A provider that holds back tool calls: replies skip it, so its window does not count.
		{ model_id: "anthropic/claude-haiku-5.5", provider_name: "Wafer", context_length: 32_000 },
		{ model_id: "z-ai/glm-5.3", tag: "wafer/fp8", context_length: 64_000 },
		{ model_id: "qwen/qwen3.8-flash", provider_name: null, context_length: null },
	],
};

const openRouterWith = (http: Layer.Layer<HttpClient.HttpClient>, env: Record<string, string> = {}) =>
	OpenRouter.layer.pipe(Layer.provide(Layer.mergeAll(http, PonderConfig.layerFromEnv({ OPENROUTER_BASE_URL: "http://fake.test/api/", ...env }))));

describe("OpenRouter's ZDR list", () => {
	it.effect("knows the models with a private endpoint, and the smallest window that replies use", () => {
		const fake = fakeOpenRouter(() => Effect.succeed(json(ZDR_LIST)));
		return Effect.gen(function* () {
			const openRouter = yield* OpenRouter.OpenRouter;
			assert.strictEqual(openRouter.url("v1/key"), "http://fake.test/api/v1/key");
			const ids = Option.getOrThrow(yield* openRouter.modelsWithZdr);
			assert.deepStrictEqual([...ids].sort(), ["anthropic/claude-haiku-5.5", "qwen/qwen3.8-flash", "z-ai/glm-5.3"]);
			assert.deepStrictEqual(yield* openRouter.contextWindow("anthropic/claude-haiku-5.5"), Option.some(180_000));
			assert.deepStrictEqual(yield* openRouter.contextWindow("z-ai/glm-5.3"), Option.none());
			assert.deepStrictEqual(yield* openRouter.contextWindow("qwen/qwen3.8-flash"), Option.none());
			// Read once, for all three.
			assert.deepStrictEqual(fake.requests.map((request) => request.url.href), ["http://fake.test/api/v1/endpoints/zdr"]);
		}).pipe(Effect.provide(openRouterWith(fake.layer)));
	});

	it.effect("answers none when the list can't be read, and logs why as before", () => {
		const fake = fakeOpenRouter(() => Effect.succeed(json({ error: "down" }, 503)));
		const logs = capturedLogs();
		return Effect.gen(function* () {
			const openRouter = yield* OpenRouter.OpenRouter;
			assert.deepStrictEqual(yield* openRouter.modelsWithZdr, Option.none());
			assert.deepStrictEqual(logs.lines, ["OpenRouter ZDR list: HTTP 503"]);
		}).pipe(Effect.provide(Layer.mergeAll(openRouterWith(fake.layer), logs.layer)));
	});

	it.effect("reads one list at a time, and the first screen does not wait for it", () => {
		const asked = Deferred.makeUnsafe<void>();
		const release = Deferred.makeUnsafe<void>();
		const fake = fakeOpenRouter(() => Effect.gen(function* () {
			yield* Deferred.succeed(asked, undefined);
			yield* Deferred.await(release);
			return json(ZDR_LIST);
		}));
		return Effect.gen(function* () {
			const openRouter = yield* OpenRouter.OpenRouter;
			const first = yield* Effect.forkChild(openRouter.modelsWithZdr);
			yield* Deferred.await(asked);
			// While the read is on its way: nothing known yet, and no second read.
			assert.deepStrictEqual(yield* openRouter.modelsWithZdrNow, Option.none());
			yield* Deferred.succeed(release, undefined);
			assert.isTrue(Option.isSome(yield* Fiber.join(first)));
			assert.isTrue(Option.isSome(yield* openRouter.modelsWithZdrNow));
			assert.strictEqual(fake.requests.length, 1);
		}).pipe(Effect.provide(openRouterWith(fake.layer)));
	});

	it.effect("reads the list again once it is an hour old, and the old list answers meanwhile", () => {
		const second = Deferred.makeUnsafe<void>();
		const fake = fakeOpenRouter(() =>
			fake.requests.length === 1 ? Effect.succeed(json(ZDR_LIST)) : Effect.andThen(Deferred.succeed(second, undefined), Effect.never),
		);
		return Effect.gen(function* () {
			const openRouter = yield* OpenRouter.OpenRouter;
			const before = Option.getOrThrow(yield* openRouter.modelsWithZdr);
			yield* TestClock.adjust("59 minutes");
			assert.strictEqual(Option.getOrThrow(yield* openRouter.modelsWithZdr), before);
			assert.strictEqual(fake.requests.length, 1);
			yield* TestClock.adjust("2 minutes");
			assert.strictEqual(Option.getOrThrow(yield* openRouter.modelsWithZdr), before);
			yield* Deferred.await(second);
			assert.strictEqual(fake.requests.length, 2);
		}).pipe(Effect.provide(openRouterWith(fake.layer)));
	});
});

describe("OpenRouterKey.check", () => {
	const keyWith = (answer: Answer) => {
		const fake = fakeOpenRouter(answer);
		const layer = OpenRouterKey.layer.pipe(
			Layer.provide(Layer.mergeAll(OpenRouter.layer, Secrets.layer)),
			Layer.provide(Layer.mergeAll(fake.layer, Database.layer)),
			Layer.provide(PonderConfig.layerFromEnv({ OPENROUTER_BASE_URL: "http://fake.test/api" })),
		);
		return { fake, layer };
	};
	const check = (answer: Answer) => {
		const { fake, layer } = keyWith(answer);
		return OpenRouterKey.OpenRouterKey.use((key) => key.check("sk-or-v1-candidate")).pipe(
			Effect.provide(layer),
			Effect.map((problem) => ({ problem: Option.getOrNull(problem), requests: fake.requests })),
		);
	};

	it.effect("asks OpenRouter with the key, and says why a key is refused", () =>
		Effect.gen(function* () {
			const ok = yield* check(() => Effect.succeed(json({ data: {} })));
			assert.strictEqual(ok.problem, null);
			assert.deepStrictEqual(ok.requests.map(({ url, authorization }) => [url.href, authorization]), [["http://fake.test/api/v1/key", "Bearer sk-or-v1-candidate"]]);
			assert.strictEqual((yield* check(() => Effect.succeed(json({}, 401)))).problem, "OpenRouter did not accept this key.");
			assert.strictEqual((yield* check(() => Effect.succeed(json({}, 403)))).problem, "OpenRouter did not accept this key.");
			assert.strictEqual((yield* check(() => Effect.succeed(json({}, 502)))).problem, "OpenRouter could not check the key (HTTP 502). Try again.");
		}),
	);

	it.effect("says when OpenRouter can't be reached, or takes over 10 seconds", () =>
		Effect.gen(function* () {
			const down = yield* check((request) => Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, cause: new TypeError("fetch failed") }) })));
			assert.strictEqual(down.problem, "Could not reach OpenRouter to check the key. Try again.");
			const slow = yield* Effect.forkChild(check(() => Effect.never));
			yield* TestClock.adjust("10 seconds");
			assert.strictEqual((yield* Fiber.join(slow)).problem, "Could not reach OpenRouter to check the key. Try again.");
		}),
	);
});
