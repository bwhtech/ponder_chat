/**
 * Memory's gate and middleware, with a fake OpenRouter: an HttpClient that answers in the
 * test, and a key that needs no secret. No database: the gate's run goes to a `runs` that
 * keeps the rows here. memory.check.ts checks the store on a real Postgres.
 */
import { assert, describe, it } from "@effect/vitest";
import type { UIMessage } from "ai";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PonderConfig from "../config.ts";
import * as OpenRouter from "../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import * as Runs from "../telemetry/Runs.ts";
import { makeDecisionGate } from "./decision-gate.ts";
import type { ExtractInput } from "./extract.ts";
import { makeMemoryMiddleware } from "./middleware.ts";
import type { MemoryAdapter, MemoryTurn } from "./types.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The gate's world: OpenRouter answers with `answer`, and `runs` keeps what it is given. */
function gateWorld(answer: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response, HttpClientError.HttpClientError>) {
	const rows: Runs.RunRow[] = [];
	const bodies: unknown[] = [];
	const client = HttpClient.make((request) => {
		if (request.body._tag === "Uint8Array") bodies.push(JSON.parse(new TextDecoder().decode(request.body.body)));
		return Effect.map(answer(request), (response) => HttpClientResponse.fromWeb(request, response));
	});
	const runs = Runs.Runs.of({ migrate: Effect.void, insert: (row) => Effect.sync(() => void rows.push(row)), usageReport: () => Effect.die("unused") });
	const key = OpenRouterKey.OpenRouterKey.of({
		key: Effect.succeed("test-key"),
		provider: Effect.die("unused"),
		status: Effect.die("unused"),
		check: () => Effect.die("unused"),
		save: () => Effect.die("unused"),
	});
	const http = Layer.succeed(HttpClient.HttpClient, client);
	const config = PonderConfig.layerFromEnv({ OPENROUTER_BASE_URL: "http://fake.test/api" });
	const layer = Layer.mergeAll(OpenRouter.layer.pipe(Layer.provide(Layer.merge(http, config))), http, config, Layer.succeed(Runs.Runs, runs), Layer.succeed(OpenRouterKey.OpenRouterKey, key));
	return { rows, bodies, gate: makeDecisionGate.pipe(Effect.provide(layer)) };
}

const input: ExtractInput = {
	scope: { threadId: "t1", userId: "p1" },
	turn: { user: "I am a nurse", assistant: "Noted." },
	existing: [{ id: "m1", kind: "fact", text: "Lives in Pune." }],
};

describe("the decision gate", () => {
	it.effect("asks the decision model, says yes above 50%, and records its run", () =>
		Effect.gen(function* () {
			const world = gateWorld(() => Effect.succeed(json({ answers: { save: { noul: 0.83 }, refuse: { noul: 0.7 } }, usage: { cost: 0.000007, input_tokens: 120, output_tokens: 0 } })));
			const gate = yield* world.gate;
			const verdict = yield* gate(input);
			assert.deepStrictEqual(verdict, {
				save: true,
				reason: "Worth remembering (83% sure)",
				refuse: ["a secret, contact or ID details, health details, or details about another person"],
				model: "perplexity/pplx-decider-v1.2",
			});
			// The turn goes in `state`, apart from the questions.
			const [body] = world.bodies as { state: unknown; questions: Record<string, unknown> }[];
			assert.deepStrictEqual(body.state, { saved_memories: ["Lives in Pune."], person_said: "I am a nurse", assistant_replied: "Noted." });
			assert.deepStrictEqual(Object.keys(body.questions), ["save", "refuse"]);
			assert.strictEqual(world.rows.length, 1);
			const [run] = world.rows;
			assert.deepStrictEqual([run.functionId, run.threadId, run.user, run.inputTokens, run.costUsd], ["memory-gate", "t1", "p1", 120, 0.000007]);
		}),
	);

	it.effect("says no below 50%, with how sure it is", () =>
		Effect.gen(function* () {
			const gate = yield* gateWorld(() => Effect.succeed(json({ answers: { save: { noul: 0.1 } } }))).gate;
			const verdict = yield* gate(input);
			assert.deepStrictEqual([verdict.save, verdict.reason, verdict.refuse], [false, "Nothing lasting (90% sure)", []]);
		}),
	);

	it.effect("fails with the status, never the provider's answer", () =>
		Effect.gen(function* () {
			const failing = yield* gateWorld(() => Effect.succeed(json({ error: { message: "upstream said: I am a nurse" } }, 503))).gate;
			const error = yield* Effect.flip(failing(input));
			assert.strictEqual(error.message, "Memory gate (perplexity/pplx-decider-v1.2): HTTP 503");
			// An answer without a probability is no decision either.
			const empty = yield* gateWorld(() => Effect.succeed(json({ answers: { save: { noul: "high" } } }))).gate;
			assert.strictEqual((yield* Effect.flip(empty(input))).message, "Memory gate (perplexity/pplx-decider-v1.2): HTTP 200");
		}),
	);

	it.effect("fails with fetch's own words when OpenRouter can't be reached", () =>
		Effect.gen(function* () {
			const gate = yield* gateWorld((request) =>
				Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, cause: new TypeError("fetch failed") }) })),
			).gate;
			assert.strictEqual((yield* Effect.flip(gate(input))).message, "Memory gate (perplexity/pplx-decider-v1.2): fetch failed");
		}),
	);
});

/** The log lines, as Ponder's logger prints them (tracing/Logger.ts). */
function capturedLogs() {
	const lines: string[] = [];
	const logger = Logger.make(({ message }) => lines.push((Array.isArray(message) ? message : [message]).join(" ")));
	return { lines, layer: Logger.layer([logger]) };
}

const messages = (user: string, reply?: string, replyId = "a1"): UIMessage[] => [
	{ id: "u1", role: "user", parts: [{ type: "text", text: user }] },
	...(reply === undefined ? [] : [{ id: replyId, role: "assistant" as const, parts: [{ type: "text" as const, text: reply }] }]),
];

/** An adapter whose saves wait for `release`, and that keeps the turns it saved. */
function heldAdapter(release: Deferred.Deferred<void>) {
	const saved: MemoryTurn[] = [];
	const adapter: MemoryAdapter<Error> = {
		id: "test",
		recall: (_scope, query) => (query === "fail" ? Effect.fail(new Error("index down")) : Effect.succeed({ systemPrompt: `recalled for ${query}` })),
		save: (_scope, turn) => Effect.as(Deferred.await(release), (saved.push(turn), turn.user === "fail" ? [{ ok: false, error: "no room" }] : [{ ok: true }])),
	};
	return { saved, adapter };
}

const ctx = { threadId: "t1", user: "p1" };
const scope = ({ threadId, user }: typeof ctx) => ({ threadId, userId: user });

describe("the memory middleware", () => {
	it.effect("recalls with the person's latest words, and goes on without memory when recall fails", () =>
		Effect.gen(function* () {
			const logs = capturedLogs();
			const { adapter } = heldAdapter(yield* Deferred.make<void>());
			const memory = yield* makeMemoryMiddleware({ adapter, scope });
			assert.strictEqual(yield* memory.recall(ctx, messages("hiking")), "recalled for hiking");
			assert.strictEqual(yield* memory.recall(ctx, []), "");
			assert.strictEqual(yield* memory.recall(ctx, messages("fail")).pipe(Effect.provide(logs.layer)), "");
			assert.deepStrictEqual(logs.lines, ["memory:test: recall failed: index down"]);
		}).pipe(Effect.scoped),
	);

	it.effect("saves a reply once, in the background, and settles once the save ends", () =>
		Effect.gen(function* () {
			const release = yield* Deferred.make<void>();
			const { saved, adapter } = heldAdapter(release);
			const memory = yield* makeMemoryMiddleware({ adapter, scope });
			// Stop and the run's last step can both save the same reply.
			yield* memory.save(ctx, messages("I am a nurse", "Noted."));
			yield* memory.save(ctx, messages("I am a nurse", "Noted."));
			// A turn without a reply is not saved.
			yield* memory.save(ctx, messages("Hello"));
			const settling = yield* Effect.forkChild(memory.settled(ctx.threadId));
			yield* Effect.yieldNow;
			assert.isUndefined(settling.pollUnsafe());
			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(settling);
			assert.deepStrictEqual(saved, [{ user: "I am a nurse", assistant: "Noted.", messageId: "a1" }]);
			// Once it ended, the same reply can be saved again: its key is free.
			yield* memory.save(ctx, messages("I am a nurse", "Noted."));
			yield* memory.settled(ctx.threadId);
			assert.strictEqual(saved.length, 2);
		}).pipe(Effect.scoped),
	);

	it.effect("logs a save that fails, and never fails itself", () => {
		const logs = capturedLogs();
		return Effect.gen(function* () {
			const release = yield* Deferred.make<void>();
			yield* Deferred.succeed(release, undefined);
			const { adapter } = heldAdapter(release);
			const memory = yield* makeMemoryMiddleware({ adapter, scope });
			yield* memory.save(ctx, messages("fail", "Ok."));
			yield* memory.settled(ctx.threadId);
			assert.deepStrictEqual(logs.lines, ["memory:test: save failed: no room"]);
		}).pipe(Effect.scoped, Effect.provide(logs.layer));
	});
});
