import { embedMany } from "ai";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
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
 * it names who caused it, and costs no credits.
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

	// No span of its own: memory.recall, memory.save and the indexing steps say enough.
	const embedAll = Effect.fnUntraced(function* (values: ReadonlyArray<string>, run: SystemRun) {
		// Made for each call, because the key can change (OpenRouterKey.ts).
		const provider = yield* keys.provider;
		const started = yield* Clock.currentTimeMillis;
		const result = yield* Effect.tryPromise({
			try: (signal) => embedMany({ model: provider.textEmbeddingModel(model, { provider: privateRouting }), values: [...values], abortSignal: signal }),
			catch: embeddingFailed,
		});
		const durationMs = (yield* Clock.currentTimeMillis) - started;
		yield* runs.insert({
			...run,
			parentId: null,
			model,
			steps: 1,
			inputTokens: result.usage.tokens,
			outputTokens: 0,
			cachedTokens: 0,
			costUsd: costOf(result.providerMetadata),
			durationMs,
			toolCalls: [],
			finishReason: "stop",
		});
		return result.embeddings;
	});

	return { model, embedMany: embedAll } satisfies Embedder;
});

/** OpenRouter's cost of the call, in its provider metadata. Null when it did not say. */
function costOf(metadata: unknown): number | null {
	const openrouter = Predicate.hasProperty(metadata, "openrouter") ? metadata.openrouter : undefined;
	const usage = Predicate.hasProperty(openrouter, "usage") ? openrouter.usage : undefined;
	return Predicate.hasProperty(usage, "cost") && Predicate.isNumber(usage.cost) ? usage.cost : null;
}

/** "[0.1,0.2]": a vector as pgvector reads it from text. */
export const vectorLiteral = (vector: ReadonlyArray<number>) => `[${vector.join(",")}]`;
