/**
 * Search in a person's chats on a real Postgres (TEST_DATABASE_URL), on the generated
 * tsvector column that Threads.migrate adds: words match as prefixes, every word must
 * match, and only the person's own threads are found.
 */
import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PonderConfig from "./config.ts";
import * as Database from "./runtime/Database.ts";
import { MATCH_END, MATCH_START, searchThreads } from "./thread-search.ts";
import * as Threads from "./threads/Threads.ts";

const url = process.env.TEST_DATABASE_URL;
const layer = Threads.layer.pipe(Layer.provideMerge(Database.layer), Layer.provide(PonderConfig.layerFromEnv(url ? { DATABASE_URL: url } : {})));

const said = (text: string): UIMessage => ({ id: randomUUID(), role: "user", parts: [{ type: "text", text }] });

describe.skipIf(!url)("searchThreads", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("finds the person's threads by word prefixes, with the words marked", () =>
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				yield* threads.migrate;
				const [owner, other] = [`search-test-${randomUUID()}`, `search-test-${randomUUID()}`];
				const [trip, code] = [randomUUID(), randomUUID()];
				yield* threads.save(trip, owner, [said("Plan a trip to Goa in December, by train")]);
				yield* threads.save(code, owner, [said("Fix the Python import error")]);
				yield* threads.save(randomUUID(), other, [said("A trip to Goa for someone else")]);

				const hits = yield* searchThreads(owner, "goa dece");
				assert.deepStrictEqual(
					hits.map((hit) => hit.id),
					[trip],
				);
				assert.strictEqual(hits[0].title, "Plan a trip to Goa in December, by train");
				assert.include(hits[0].excerpt, `${MATCH_START}Goa${MATCH_END}`);
				assert.deepStrictEqual(yield* searchThreads(owner, "goa python"), []);
				// Only letters and digits reach to_tsquery.
				assert.deepStrictEqual(
					(yield* searchThreads(owner, "pyth & | !")).map((hit) => hit.id),
					[code],
				);
				assert.deepStrictEqual(yield* searchThreads(owner, "  !! "), []);
				for (const id of [trip, code]) yield* threads.remove(id, owner);
			}),
		);
	});
});
