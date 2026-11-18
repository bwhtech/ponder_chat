/**
 * The threads repository on a real Postgres. Runs when TEST_DATABASE_URL is set
 * (vitest.config.ts). Each test uses ids of its own, and the last one deletes them, so
 * the database's other threads are left alone.
 */
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import type { UIMessage } from "ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PonderConfig from "../config.ts";
import * as Database from "../runtime/Database.ts";
import * as Threads from "./Threads.ts";

const url = process.env.TEST_DATABASE_URL;
const layer = Threads.layer.pipe(Layer.provideMerge(Database.layer), Layer.provide(PonderConfig.layerFromEnv(url ? { DATABASE_URL: url } : {})));

const run = Math.random().toString(36).slice(2, 10);
const owner = `test-${run}`;
const other = `test-other-${run}`;
const id = (name: string) => `${run}-${name}`;

const message = (role: "user" | "assistant", text: string): UIMessage => ({ id: `${role}-${text.length}`, role, parts: [{ type: "text", text }] });

describe.skipIf(!url)("Threads", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("migrates twice without a change", () =>
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				yield* threads.migrate;
				yield* threads.migrate;
			}),
		);

		it.effect("saves a thread and loads its messages as they were", () =>
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const messages = [message("user", "Plan a trip to Lisbon"), message("assistant", 'Sure: "day one" ✓\nThen day two.')];
				yield* threads.save(id("a"), owner, messages);
				assert.deepStrictEqual(yield* threads.load(id("a")), messages);
				assert.deepStrictEqual(yield* threads.owner(id("a")), Option.some(owner));
				const version = yield* threads.version(id("a"), owner);
				assert.isTrue(Option.isSome(version) && version.value.updatedAt instanceof Date);
			}),
		);

		it.effect("knows nothing of a thread not saved yet", () =>
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				assert.deepStrictEqual(yield* threads.load(id("none")), []);
				assert.deepStrictEqual(yield* threads.owner(id("none")), Option.none());
				assert.deepStrictEqual(yield* threads.version(id("none"), owner), Option.none());
			}),
		);

		it.effect("leaves someone else's thread alone", () =>
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const mine = yield* threads.load(id("a"));
				yield* threads.save(id("a"), other, [message("user", "Not yours")]);
				assert.deepStrictEqual(yield* threads.load(id("a")), mine);
				assert.isFalse(yield* threads.update(id("a"), other, []));
				assert.isFalse(yield* threads.rename(id("a"), other, "Taken"));
				assert.isFalse(yield* threads.remove(id("a"), other));
				assert.deepStrictEqual(yield* threads.version(id("a"), other), Option.none());
			}),
		);

		it.effect("updates a saved thread, and not a deleted one", () =>
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const before = yield* threads.version(id("a"), owner);
				const messages = [...(yield* threads.load(id("a"))), message("user", "And Porto?")];
				assert.isTrue(yield* threads.update(id("a"), owner, messages));
				assert.deepStrictEqual(yield* threads.load(id("a")), messages);
				const after = yield* threads.version(id("a"), owner);
				assert.isTrue(Option.isSome(before) && Option.isSome(after) && after.value.updatedAt.getTime() >= before.value.updatedAt.getTime());
				assert.isFalse(yield* threads.update(id("gone"), owner, messages));
			}),
		);

		it.effect("lists the person's threads newest first, named by title or first message", () =>
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				yield* threads.save(id("b"), owner, [message("assistant", "Hello"), message("user", "Second thread\nwith more lines")]);
				const list = yield* threads.list(owner);
				assert.deepStrictEqual(
					list.map(({ id, title, messages }) => ({ id, title, messages })),
					[
						{ id: id("b"), title: "Second thread", messages: 2 },
						{ id: id("a"), title: "Plan a trip to Lisbon", messages: 3 },
					],
				);
				assert.match(list[0]!.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
				assert.deepStrictEqual(yield* threads.list(`nobody-${run}`), []);
			}),
		);

		it.effect("renames a thread, and an empty title names it by its first message again", () =>
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				assert.isTrue(yield* threads.rename(id("a"), owner, "  Lisbon  "));
				assert.strictEqual((yield* threads.list(owner)).find((thread) => thread.id === id("a"))?.title, "Lisbon");
				assert.isTrue(yield* threads.rename(id("a"), owner, "   "));
				assert.strictEqual((yield* threads.list(owner)).find((thread) => thread.id === id("a"))?.title, "Plan a trip to Lisbon");
			}),
		);

		it.effect("fills the search column from the title and the text parts", () =>
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const sql = yield* PgClient.PgClient;
				yield* threads.rename(id("a"), owner, "Holiday");
				const found = (q: string) => sql<{ id: string }>`select id from threads where owner = ${owner} and search @@ to_tsquery('simple', ${q}) order by id`;
				assert.deepStrictEqual(yield* found("holiday"), [{ id: id("a") }]);
				assert.deepStrictEqual(yield* found("porto"), [{ id: id("a") }]);
				// The JSON's escapes are blanked: "\n" does not glue "thread" to "with".
				assert.deepStrictEqual(yield* found("with"), [{ id: id("b") }]);
			}),
		);

		it.effect("deletes the person's threads", () =>
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				assert.isTrue(yield* threads.remove(id("a"), owner));
				assert.isTrue(yield* threads.remove(id("b"), owner));
				assert.isFalse(yield* threads.remove(id("a"), owner));
				assert.deepStrictEqual(yield* threads.list(owner), []);
			}),
		);
	});
});
