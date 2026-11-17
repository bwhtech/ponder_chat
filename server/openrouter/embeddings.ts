import { randomUUID } from "node:crypto";
import type { OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import { embedMany } from "ai";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import type { SqlError } from "effect/sql/SqlError";
import * as PonderConfig from "../config.ts";
import type { UnreadableSecret } from "../secrets/Secrets.ts";
import { EmbeddingFailed, statusOf } from "../memory/errors.ts";
import * as Runs from "../telemetry/Runs.ts";
import { privateRouting } from "./OpenRouter.ts";
import * as OpenRouterKey from "./OpenRouterKey.ts";

/**
 * Embeddings with PONDER_EMBEDDING_MODEL through OpenRouter, for memory and for workspace
 * documents. Each call is one `runs` row of the app's own spend (Runs.SYSTEM_FUNCTION_IDS):
 * it names who caused it, and costs no credits. A call that fails after some of its values
 * were paid for has a row too, `<id>:failed:<uuid>`, so no spend goes unseen.
 */

/** Who and what one call is for. The id is the `runs` row's: a second call with the same id keeps the first row. */
export type SystemRun = { id: string; functionId: Runs.SystemFunctionId; user: string | null; threadId: string | null };

export type Embedder = {
	readonly model: string;
	/** One vector for each value, in order. */
	readonly embedMany: (values: ReadonlyArray<string>, run: SystemRun) => Effect.Effect<number[][], EmbeddingError>;
};

export type EmbeddingError = EmbeddingFailed | OpenRouterKey.NoOpenRouterKey | UnreadableSecret | SqlError;

/** The embedder, on the services of the environment it is made in. */
export const makeEmbedder = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const keys = yield* OpenRouterKey.OpenRouterKey;
	const runs = yield* Runs.Runs;
	const model = config.embeddingModel;
	const embeddingFailed = (cause: unknown) => new EmbeddingFailed({ model, status: statusOf(cause), cause });
	// Some models have no endpoint that takes many values under Zero Data Retention:
	// OpenRouter answers 404 for google/gemini-embedding-2 with two values or more. Once
	// that is seen, each value is a call of its own, and one `runs` row adds them up.
	const oneAtATime = yield* Ref.make(false);

	const call = (provider: OpenRouterProvider, values: ReadonlyArray<string>) =>
		Effect.tryPromise({
			try: (signal) => embedMany({ model: provider.textEmbeddingModel(model, { provider: privateRouting }), values: [...values], abortSignal: signal }),
			catch: embeddingFailed,
		}).pipe(Effect.map((result): Usage => ({ embeddings: result.embeddings, tokens: result.usage.tokens, costUsd: costOf(result.providerMetadata), calls: 1 })));

	// The vectors of the calls that worked in a batch that failed, by the run's id: the
	// batch's next try (a workflow step tried again) pays only for the values that failed.
	const kept = new Map<string, Map<string, number[]>>();

	/**
	 * Each value in a call of its own. The AI SDK tries each call 3 times; a value that still
	 * fails fails the batch, but only once every call has ended, so the ones that worked are
	 * counted and kept.
	 */
	const eachAlone = Effect.fnUntraced(function* (provider: OpenRouterProvider, values: ReadonlyArray<string>, runId: string) {
		const vectors = kept.get(runId) ?? new Map<string, number[]>();
		const todo = [...new Set(values)].filter((value) => !vectors.has(value));
		const tries = yield* Effect.forEach(todo, (value) => Effect.result(call(provider, [value])), { concurrency: CALLS_AT_ONCE });
		const done = tries.flatMap((tried, index) => (tried._tag === "Success" ? [[todo[index], tried.success] as const] : []));
		for (const [value, usage] of done) vectors.set(value, usage.embeddings[0]);
		const usage = addUp(done.map(([, usage]) => usage));
		const failure = tries.find((tried) => tried._tag === "Failure")?.failure;
		if (!failure) {
			kept.delete(runId);
			return { usage: { ...usage, embeddings: values.map((value) => vectors.get(value)!) }, failure: null } satisfies Outcome;
		}
		keep(runId, vectors);
		return { usage, failure } satisfies Outcome;
	});

	const keep = (runId: string, vectors: Map<string, number[]>) => {
		kept.delete(runId);
		kept.set(runId, vectors);
		for (const oldest of kept.keys()) if (kept.size > KEPT_RUNS) kept.delete(oldest);
	};

	const embedValues = Effect.fnUntraced(function* (provider: OpenRouterProvider, values: ReadonlyArray<string>, runId: string) {
		if (values.length > 1 && (yield* Ref.get(oneAtATime))) return yield* eachAlone(provider, values, runId);
		return yield* call(provider, values).pipe(
			Effect.map((usage): Outcome => ({ usage, failure: null })),
			Effect.catchTags({
				EmbeddingFailed: (error) => (error.status === 404 && values.length > 1 ? Effect.andThen(Ref.set(oneAtATime, true), eachAlone(provider, values, runId)) : Effect.fail(error)),
			}),
		);
	});

	// No span of its own: memory.recall, memory.save and the indexing steps say enough.
	const embedAll = Effect.fnUntraced(function* (values: ReadonlyArray<string>, run: SystemRun) {
		// Made for each call, because the key can change (OpenRouterKey.ts).
		const provider = yield* keys.provider;
		const started = yield* Clock.currentTimeMillis;
		const { usage, failure } = yield* embedValues(provider, values, run.id);
		const durationMs = (yield* Clock.currentTimeMillis) - started;
		// A batch that failed still paid for the calls that worked. Its row has an id of its own:
		// the batch's next try saves its row under the run's id.
		if (usage.calls > 0) {
			const id = failure ? `${run.id}:failed:${randomUUID()}` : run.id;
			yield* runs.insert({
				...run,
				id,
				parentId: null,
				model,
				steps: usage.calls,
				inputTokens: usage.tokens,
				outputTokens: 0,
				cachedTokens: 0,
				costUsd: usage.costUsd,
				durationMs,
				toolCalls: [],
				finishReason: failure ? "error" : "stop",
			});
		}
		if (failure) return yield* failure;
		return usage.embeddings;
	});

	return { model, embedMany: embedAll } satisfies Embedder;
});

/** Calls at once when each value is a call of its own. */
const CALLS_AT_ONCE = 8;
/** Failed batches whose vectors are kept for their next try; the oldest go first. */
const KEPT_RUNS = 4;

type Usage = { embeddings: number[][]; tokens: number; costUsd: number | null; calls: number };
/** What the calls of a batch paid for, and the first failure. */
type Outcome = { usage: Usage; failure: EmbeddingFailed | null };

function addUp(parts: ReadonlyArray<Usage>): Usage {
	const costs = parts.flatMap((part) => (part.costUsd === null ? [] : [part.costUsd]));
	return {
		embeddings: parts.flatMap((part) => part.embeddings),
		tokens: parts.reduce((sum, part) => sum + part.tokens, 0),
		costUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null,
		calls: parts.length,
	};
}

/** OpenRouter's cost of the call, in its provider metadata. Null when it did not say. */
function costOf(metadata: unknown): number | null {
	const openrouter = Predicate.hasProperty(metadata, "openrouter") ? metadata.openrouter : undefined;
	const usage = Predicate.hasProperty(openrouter, "usage") ? openrouter.usage : undefined;
	return Predicate.hasProperty(usage, "cost") && Predicate.isNumber(usage.cost) ? usage.cost : null;
}

/** "[0.1,0.2]": a vector as pgvector reads it from text. */
export const vectorLiteral = (vector: ReadonlyArray<number>) => `[${vector.join(",")}]`;
