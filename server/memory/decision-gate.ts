import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import * as PonderConfig from "../config.ts";
import * as OpenRouter from "../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import { requestProblem } from "../runtime/Http.ts";
import { sqlMessage } from "../runtime/Database.ts";
import * as Runs from "../telemetry/Runs.ts";
import { MemoryGateFailed } from "./errors.ts";
import type { ExtractInput, Gate } from "./extract.ts";

/**
 * Memory's gate on an OpenRouter decision model (the Decisions API): instead of writing
 * text, it answers the yes/no questions in gate.json with a probability, in about a
 * quarter of a second, and only its input is billed. `save` decides whether the writer
 * runs; `refuse` warns the writer that the turn holds something never to keep. The Seva
 * platform's benchmark chose Perplexity Decider V1.2 (PONDER_MEMORY_GATE_MODEL). gate.json
 * is read on every call.
 */
const QUESTIONS_PATH = new URL("./gate.json", import.meta.url);
const THRESHOLD = 0.5;

/** The file ships with the code: a failure to read it is a bug, a defect. */
export const readGateQuestions = Effect.promise(() => readFile(QUESTIONS_PATH, "utf8"));

// The Decisions API's answer, leniently: what is missing or of another shape is left out,
// as the old `body.answers?.save?.noul` read it.
const Probability = Schema.optional(Schema.NullOr(Schema.Struct({ noul: Schema.optional(Schema.NullOr(Schema.Number)) })));
const DecisionsAnswer = Schema.Struct({
	answers: Schema.optional(Schema.NullOr(Schema.Struct({ save: Probability, refuse: Probability }))),
	usage: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				cost: Schema.optional(Schema.NullOr(Schema.Number)),
				input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
				output_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
			}),
		),
	),
});
const NO_ANSWER: typeof DecisionsAnswer.Type = {};

/** The gate, on the services of the environment it is made in. */
export const makeDecisionGate = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const openRouter = yield* OpenRouter.OpenRouter;
	const keys = yield* OpenRouterKey.OpenRouterKey;
	const client = yield* HttpClient.HttpClient;
	const runs = yield* Runs.Runs;
	const model = config.memoryGateModel;
	const endpoint = openRouter.url("alpha/decisions");

	// No span of its own: it runs inside memory.save.
	const gate: Gate = Effect.fnUntraced(function* ({ scope, turn, existing }: ExtractInput) {
		const started = yield* Clock.currentTimeMillis;
		// The turn is data: it goes in `state`, apart from the questions.
		const state = { saved_memories: existing.map((m) => m.text), person_said: turn.user, assistant_replied: turn.assistant };
		const questions = JSON.parse(yield* readGateQuestions);
		const request = HttpClientRequest.post(endpoint).pipe(
			HttpClientRequest.setHeader("Authorization", `Bearer ${yield* keys.key}`),
			HttpClientRequest.bodyJsonUnsafe({ model, state, questions, provider: OpenRouter.privateRoutingBody }),
		);
		const response = yield* client
			.execute(request)
			.pipe(Effect.catchTags({ HttpClientError: (error) => Effect.fail(new MemoryGateFailed({ model, problem: requestProblem(error), cause: error })) }));
		const body = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(DecisionsAnswer)), Effect.orElseSucceed(() => NO_ANSWER));
		const save = body.answers?.save?.noul;
		const refuse = body.answers?.refuse?.noul;
		if (response.status < 200 || response.status >= 300 || typeof save !== "number") {
			return yield* new MemoryGateFailed({ model, problem: `HTTP ${response.status}` });
		}

		// Not a generateText call, so it is written to `runs` here, as telemetry writes the others. Credits count it.
		const run: Runs.RunRow = {
			id: randomUUID(),
			parentId: null,
			threadId: scope.threadId,
			user: scope.userId ?? null,
			functionId: "memory-gate",
			model,
			steps: 1,
			inputTokens: body.usage?.input_tokens ?? 0,
			outputTokens: body.usage?.output_tokens ?? 0,
			cachedTokens: 0,
			costUsd: body.usage?.cost ?? null,
			durationMs: (yield* Clock.currentTimeMillis) - started,
			toolCalls: [],
			finishReason: "stop",
		};
		yield* runs.insert(run).pipe(Effect.catchTags({ SqlError: (error) => Effect.logError("[memory] could not record the gate's run:", sqlMessage(error)) }));

		const refused = typeof refuse === "number" && refuse >= THRESHOLD;
		const pct = (p: number) => `${Math.round(p * 100)}%`;
		return {
			save: save >= THRESHOLD,
			reason: save >= THRESHOLD ? `Worth remembering (${pct(save)} sure)` : `Nothing lasting (${pct(1 - save)} sure)`,
			refuse: refused ? ["a secret, contact or ID details, health details, or details about another person"] : [],
			model,
		};
	});
	return gate;
});
