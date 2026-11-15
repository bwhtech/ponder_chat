/**
 * The pgvector index (pgvector-index.ts), and the store's search through it (postgres.ts),
 * on a real Postgres with pgvector, with a fake embedding model. Runs when
 * TEST_DATABASE_URL is set. Each test uses owners of its own and deletes them; the
 * check `memory.check.ts --index` runs the same with real embeddings.
 */
import * as PgClient from "@effect/sql-pg/PgClient";
import { assert, describe, it } from "@effect/vitest";
import type { OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import { MockEmbeddingModelV4 } from "ai/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PonderConfig from "../config.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import * as Database from "../runtime/Database.ts";
import { EmbeddingFailed } from "./errors.ts";
import type { Extractor } from "./extract.ts";
import { makePgvectorIndex } from "./pgvector-index.ts";
import * as MemoryStore from "./postgres.ts";

/** A meaning of three words: food, running and code. A text is near the words it holds. */
const TOPICS = [/cook|food|eat|dinner|खाने/i, /run|marathon|km/i, /python|code|data/i];
const meaning = (text: string) => TOPICS.map((topic) => (topic.test(text) ? 1 : 0.01));

let embeddingsDown = false;
const embedder = new MockEmbeddingModelV4({
	doEmbed: async ({ values }) => {
		if (embeddingsDown) throw new Error("embeddings down");
		return { embeddings: values.map(meaning), warnings: [] };
	},
});
const provider = { textEmbeddingModel: () => embedder } as unknown as OpenRouterProvider;
const unused = Effect.die("unused");
const key = Layer.succeed(
	OpenRouterKey.OpenRouterKey,
	OpenRouterKey.OpenRouterKey.of({ key: Effect.succeed("k"), provider: Effect.succeed(provider), status: unused, check: () => unused, save: () => unused }),
);

const url = process.env.TEST_DATABASE_URL;
const layer = Layer.mergeAll(Database.layer, key).pipe(Layer.provideMerge(PonderConfig.layerFromEnv(url ? { DATABASE_URL: url } : {})));

const run = Math.random().toString(36).slice(2, 10);
const owner = (name: string) => `test-${run}-${name}`;

/** Keeps what the person said as a fact. */
const extract: Extractor = ({ turn }) => Effect.succeed({ summary: "Saved", operations: [{ op: "add", kind: "fact", text: turn.user, quote: turn.user, reason: "said" }], model: "fake" });

describe.skipIf(!url)("the pgvector index", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("finds a person's memories by meaning and by words, best first, and only theirs", () =>
			Effect.gen(function* () {
				const index = yield* makePgvectorIndex;
				const cook = owner("cook");
				yield* index.upsert([
					{ id: `${cook}-1`, owner: cook, text: "Cooks South Indian food" },
					{ id: `${cook}-2`, owner: cook, text: "Trains for a marathon" },
					{ id: `${cook}-3`, owner: cook, text: "Writes Python at work" },
					{ id: `${owner("other")}-1`, owner: owner("other"), text: "Runs every day" },
				]);
				assert.deepStrictEqual((yield* index.search(cook, "आज रात खाने में क्या बनाऊं?", 1)), [`${cook}-1`]);
				assert.deepStrictEqual((yield* index.search(cook, "how many km this week?", 2))[0], `${cook}-2`);
				// Words count too: "Python" is in one memory's text.
				assert.deepStrictEqual((yield* index.search(cook, "Python", 3))[0], `${cook}-3`);
				assert.notInclude(yield* index.search(cook, "running", 8), `${owner("other")}-1`);

				yield* index.remove([`${cook}-2`]);
				assert.notInclude(yield* index.search(cook, "marathon", 8), `${cook}-2`);
				// Upsert replaces a memory's text.
				yield* index.upsert([{ id: `${cook}-3`, owner: cook, text: "Runs half marathons" }]);
				assert.deepStrictEqual((yield* index.search(cook, "marathon", 1)), [`${cook}-3`]);
			}),
		);

		it.effect("fails with the model, never the text, when the embeddings fail", () =>
			Effect.gen(function* () {
				const index = yield* makePgvectorIndex;
				embeddingsDown = true;
				const error = yield* Effect.flip(index.search(owner("cook"), "dinner", 1)).pipe(Effect.ensuring(Effect.sync(() => (embeddingsDown = false))));
				assert.instanceOf(error, EmbeddingFailed);
				assert.strictEqual(error.message, "Embeddings (google/gemini-embedding-2) failed");
			}),
		);

		it.effect("lets the store recall by meaning above recallAll, and fall back to Postgres when the index fails", () => {
			const lines: string[] = [];
			const logger = Logger.layer([Logger.make(({ message }) => lines.push((Array.isArray(message) ? message : [message]).join(" ")))]);
			return Effect.gen(function* () {
				const store = yield* MemoryStore.makeWith({ extract, index: yield* makePgvectorIndex, recallAll: 1, topK: 1 });
				yield* store.migrate;
				const scope = { threadId: "t1", userId: owner("store") };
				yield* store.save(scope, { user: "I cook vegetarian food", assistant: "Ok." });
				yield* store.save(scope, { user: "I run a marathon in March", assistant: "Ok." });
				const recalled = yield* store.recall(scope, "what should I eat for dinner?");
				assert.deepStrictEqual(recalled.fragments?.map((fragment) => fragment.text), ["I cook vegetarian food"]);
				assert.match(recalled.systemPrompt, /These are the 1 most relevant of 2 memories\./);

				embeddingsDown = true;
				const fallback = yield* store.recall(scope, "marathon").pipe(Effect.ensuring(Effect.sync(() => (embeddingsDown = false))));
				assert.deepStrictEqual(fallback.fragments?.map((fragment) => fragment.text), ["I run a marathon in March"]);
				assert.deepStrictEqual(lines, ["memory: index search failed, using Postgres: Embeddings (google/gemini-embedding-2) failed"]);

				// A save whose index update fails is saved, and says so.
				embeddingsDown = true;
				const receipts = yield* store.save(scope, { user: "I write code", assistant: "Ok." }).pipe(Effect.ensuring(Effect.sync(() => (embeddingsDown = false))));
				assert.deepStrictEqual(
					receipts.map((receipt) => [receipt.ok, receipt.error]),
					[[false, "Saved, but the search index failed: Embeddings (google/gemini-embedding-2) failed"]],
				);
				assert.strictEqual((yield* store.list(scope)).length, 3);
			}).pipe(Effect.provide(logger));
		});

		it.effect("cleans up", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const like = `test-${run}-%`;
				yield* sql`delete from memory_vectors where owner like ${like}`;
				yield* sql`delete from memories where owner like ${like}`;
				yield* sql`delete from memory_saves where owner like ${like}`;
			}),
		);
	});
});
