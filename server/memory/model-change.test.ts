/**
 * A change of PONDER_EMBEDDING_MODEL: the memory index made with one fake model (vectors of
 * width 3) is opened with another (width 5). Search must not fail on the old rows, and
 * `syncIndex` must rebuild them with the new model. On a real Postgres with pgvector
 * (TEST_DATABASE_URL), in a schema of its own: a rebuild empties the whole table.
 */
import * as PgClient from "@effect/sql-pg/PgClient";
import { assert, describe, it } from "@effect/vitest";
import type { OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import { MockEmbeddingModelV4 } from "ai/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PonderConfig from "../config.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import * as Database from "../runtime/Database.ts";
import * as Runs from "../telemetry/Runs.ts";
import type { Extractor } from "./extract.ts";
import { makePgvectorIndex } from "./pgvector-index.ts";
import * as MemoryStore from "./postgres.ts";

const MODEL_A = "fake/three";
const MODEL_B = "fake/five";
const TOPICS = [/cook|food|eat|dinner/i, /run|marathon|km/i, /python|code|data/i];

/** A fake model whose vectors have `width` numbers: the topics first, then zeros. */
const fakeModel = (width: number) =>
	new MockEmbeddingModelV4({
		doEmbed: async ({ values }) => ({
			embeddings: values.map((text) => Array.from({ length: width }, (_, i) => (TOPICS[i]?.test(text) ? 1 : 0.01))),
			usage: { tokens: values.length * 5 },
			providerMetadata: { openrouter: { usage: { cost: 0.00001 } } },
			warnings: [],
		}),
	});
const models: Record<string, MockEmbeddingModelV4> = { [MODEL_A]: fakeModel(3), [MODEL_B]: fakeModel(5) };
const provider = { textEmbeddingModel: (id: string) => models[id] } as unknown as OpenRouterProvider;
const unused = Effect.die("unused");
const key = Layer.succeed(
	OpenRouterKey.OpenRouterKey,
	OpenRouterKey.OpenRouterKey.of({ key: Effect.succeed("k"), provider: Effect.succeed(provider), status: unused, check: () => unused, save: () => unused }),
);

const base = process.env.TEST_DATABASE_URL;
const run = Math.random().toString(36).slice(2, 10);
const schema = `test_memory_model_${run}`;
// `public` stays on the path for pgvector's type and operators.
const url = base ? `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema},public`)}` : undefined;
const env = (model: string): Record<string, string> => (url ? { DATABASE_URL: url, PONDER_EMBEDDING_MODEL: model } : {});
const layer = Runs.layer.pipe(Layer.provideMerge(Layer.mergeAll(Database.layer, key)), Layer.provideMerge(PonderConfig.layerFromEnv(env(MODEL_A))));

/** The index as the app makes it when PONDER_EMBEDDING_MODEL is `model`. */
const indexOf = (model: string) => makePgvectorIndex.pipe(Effect.provide(PonderConfig.layerFromEnv(env(model))));
const storeOf = (model: string) =>
	Effect.gen(function* () {
		return yield* MemoryStore.makeWith({ extract, index: yield* indexOf(model), recallAll: 1, topK: 1 });
	});

/** Keeps what the person said as a fact. */
const extract: Extractor = ({ turn }) => Effect.succeed({ summary: "Saved", operations: [{ op: "add", kind: "fact", text: turn.user, quote: turn.user, reason: "said" }], model: "fake" });
const scope = { threadId: "t1", userId: `test-${run}-cook` };

/** The `memory-embed` rows in runs: one for each embedding call. */
const embedCalls = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const [row] = yield* sql<{ count: number }>`select count(*)::int as count from runs where function_id = 'memory-embed'`;
	return row.count;
});

const vectorRows = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	return yield* sql<{ model: string | null; width: number }>`select model, vector_dims(embedding) as width from memory_vectors order by id`;
});

describe.skipIf(!base)("the memory index after a change of embedding model", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("sets up a schema of its own, with two memories made by model A", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql.unsafe(`create schema ${schema}`);
				// Runs.migrate drops `charged_runs` by name: without one here, that would be public's.
				yield* sql.unsafe(`create view ${schema}.charged_runs as select 1`);
				yield* Runs.Runs.use((runs) => runs.migrate);
				const store = yield* storeOf(MODEL_A);
				yield* store.migrate;
				yield* store.save(scope, { user: "I cook vegetarian food", assistant: "Ok." });
				yield* store.save(scope, { user: "I run a marathon in March", assistant: "Ok." });
				assert.deepStrictEqual(yield* vectorRows, [
					{ model: MODEL_A, width: 3 },
					{ model: MODEL_A, width: 3 },
				]);
			}),
		);

		it.effect("searches without error before the rebuild, and rebuilds with model B though the count is the same", () =>
			Effect.gen(function* () {
				const index = yield* indexOf(MODEL_B);
				const store = yield* storeOf(MODEL_B);
				// Rows of model A only: model B's search reads none of them, so it can't compare widths.
				assert.deepStrictEqual(yield* index.search(scope.userId, "marathon", 1), []);
				assert.deepStrictEqual(yield* index.counts, { current: 0, outdated: 2 });
				// The store falls back to Postgres's words meanwhile.
				const meanwhile = yield* store.recall(scope, "marathon");
				assert.deepStrictEqual(meanwhile.fragments?.map((fragment) => fragment.text), ["I run a marathon in March"]);

				// A memory saved meanwhile is model B's: the table holds both widths, and search still works.
				yield* store.save(scope, { user: "I write Python code", assistant: "Ok." });
				assert.deepStrictEqual(yield* index.search(scope.userId, "python", 1), [(yield* store.list(scope)).find((m) => m.text.includes("Python"))!.id]);
				// Three rows, three memories: the old count check saw nothing to do.
				assert.deepStrictEqual(yield* index.counts, { current: 1, outdated: 2 });

				const before = yield* embedCalls;
				yield* store.syncIndex;
				assert.deepStrictEqual(
					(yield* vectorRows).map((row) => [row.model, row.width]),
					[
						[MODEL_B, 5],
						[MODEL_B, 5],
						[MODEL_B, 5],
					],
				);
				assert.deepStrictEqual(yield* index.counts, { current: 3, outdated: 0 });
				// The rebuild's embeddings are the app's spend, in runs.
				assert.strictEqual(yield* embedCalls, before + 1);

				const found = yield* store.recall(scope, "what should I eat for dinner?");
				assert.deepStrictEqual(found.fragments?.map((fragment) => fragment.text), ["I cook vegetarian food"]);
				// In step now: nothing to rebuild, and nothing embedded.
				const settled = yield* embedCalls;
				yield* store.syncIndex;
				assert.strictEqual(yield* embedCalls, settled);
			}),
		);

		it.effect("rebuilds rows that have no model, as the rows from before the model column", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`update memory_vectors set model = null where text like '%marathon%'`;
				const store = yield* storeOf(MODEL_B);
				const index = yield* indexOf(MODEL_B);
				assert.deepStrictEqual(yield* index.counts, { current: 2, outdated: 1 });
				yield* store.syncIndex;
				assert.deepStrictEqual(yield* index.counts, { current: 3, outdated: 0 });
				assert.ok((yield* vectorRows).every((row) => row.model === MODEL_B));
			}),
		);

		it.effect("migrates a table made before the model column", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`alter table memory_vectors drop column model`;
				const index = yield* indexOf(MODEL_B);
				assert.deepStrictEqual(yield* index.counts, { current: 0, outdated: 3 });
				yield* (yield* storeOf(MODEL_B)).syncIndex;
				assert.deepStrictEqual(yield* index.counts, { current: 3, outdated: 0 });
			}),
		);

		it.effect("cleans up", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql.unsafe(`drop schema if exists ${schema} cascade`);
			}),
		);
	});
});
