/**
 * What Ponder needs from @effect/sql-pg, checked on a real Postgres with pgvector: the
 * evidence for docs/effect.md, "Database". Runs when TEST_DATABASE_URL is set
 * (vitest.config.ts); it creates and drops its own tables.
 */
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as PonderConfig from "../config.ts";
import { SQL_STATEMENT_SPAN } from "../tracing/setup.ts";
import * as Database from "./Database.ts";

const url = process.env.TEST_DATABASE_URL;
const layer = Database.layer.pipe(Layer.provide(PonderConfig.layerFromEnv(url ? { DATABASE_URL: url } : {})));
const table = `gate_${Math.random().toString(36).slice(2, 10)}`;

describe.skipIf(!url)("@effect/sql-pg for Ponder", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("creates its table, with a notice-making migration that stays quiet", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`create extension if not exists vector`;
				// The second one makes a NOTICE ("already exists, skipping"), which the client drops.
				yield* sql`create extension if not exists vector`;
				yield* sql.unsafe(`create table if not exists ${table} (id text primary key, messages jsonb not null default '[]', at timestamptz not null default now(), n bigint, embedding vector, words tsvector)`);
				yield* sql.unsafe(`create table if not exists ${table} (id text primary key)`);
			}),
		);

		it.effect("keeps jsonb as it was written, with sql.json", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: 'Hi "wörld" \\ \n ✓ 🎉  ' }], metadata: { big: 12345678901234, nested: [null, true, { b: 1, a: 2 }] } }];
				yield* sql`insert into ${sql(table)} (id, messages) values (${"json"}, ${sql.json(messages)})`;
				const [row] = yield* sql<{ messages: unknown }>`select messages from ${sql(table)} where id = ${"json"}`;
				assert.deepStrictEqual(row.messages, messages);
			}),
		);

		it.effect("reads timestamptz as a Date and int8 as a bigint (postgres.js gave a string)", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`update ${sql(table)} set n = ${9_007_199_254_740_993n} where id = ${"json"}`;
				const [row] = yield* sql<{ at: unknown; n: unknown; count: unknown; small: unknown }>`
					select at, n, count(*) over () as count, count(*) over ()::int as small from ${sql(table)} where id = ${"json"}`;
				assert.instanceOf(row.at, Date);
				assert.strictEqual(row.n, 9_007_199_254_740_993n);
				assert.strictEqual(row.count, 1n);
				assert.strictEqual(row.small, 1);
			}),
		);

		it.effect("matches arrays with = any(...) and in (...), and reads them back", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				assert.deepStrictEqual(yield* sql`select id from ${sql(table)} where id = any(${["json", "other"]})`, [{ id: "json" }]);
				assert.deepStrictEqual(yield* sql`select id from ${sql(table)} where id = any(${[] as string[]})`, []);
				assert.deepStrictEqual(yield* sql`select id from ${sql(table)} where id in ${sql.in(["json"])}`, [{ id: "json" }]);
				assert.deepStrictEqual(yield* sql`select array_agg(id) as ids from ${sql(table)}`, [{ ids: ["json"] }]);
			}),
		);

		it.effect("writes pgvector vectors and searches them; a raw vector or tsvector can't be read, ::text can", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`insert into ${sql(table)} ${sql.insert([{ id: "v1", embedding: "[1,2,3]" }, { id: "v2", embedding: "[3,2,1]" }])}`;
				const [nearest] = yield* sql<{ id: string; distance: number }>`
					select id, embedding <=> ${"[1,2,4]"}::vector as distance from ${sql(table)} where embedding is not null order by distance limit 1`;
				assert.strictEqual(nearest.id, "v1");
				assert.isNumber(nearest.distance);
				// The client reads every column in binary, and has no codec for pgvector's or tsvector's
				// binary form: it reads them as UTF-8, which fails or gives bytes. Cast to text to read one.
				const raw = yield* sql`select embedding from ${sql(table)} where id = ${"v1"}`.pipe(Effect.result);
				assert.isTrue(raw._tag === "Failure" || (raw.success[0] as { embedding: unknown }).embedding !== "[1,2,3]");
				assert.deepStrictEqual(yield* sql`select embedding::text as e from ${sql(table)} where id = ${"v1"}`, [{ e: "[1,2,3]" }]);
				yield* sql`update ${sql(table)} set words = to_tsvector('simple', ${"Hello world"}) where id = ${"v1"}`;
				const words = yield* sql<{ words: unknown }>`select words from ${sql(table)} where id = ${"v1"}`.pipe(Effect.result);
				assert.isTrue(words._tag === "Failure" || words.success[0]!.words !== "'hello':1 'world':2");
				assert.deepStrictEqual(yield* sql`select words::text as words from ${sql(table)} where id = ${"v1"}`, [{ words: "'hello':1 'world':2" }]);
				assert.deepStrictEqual(yield* sql`select id from ${sql(table)} where words @@ to_tsquery('simple', ${"hell:*"})`, [{ id: "v1" }]);
			}),
		);

		it.effect("rolls a failed transaction back", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const failed = yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* sql`insert into ${sql(table)} (id) values (${"tx"})`;
							return yield* Effect.fail("stop" as const);
						}),
					)
					.pipe(Effect.flip);
				assert.strictEqual(failed, "stop");
				assert.deepStrictEqual(yield* sql`select id from ${sql(table)} where id = ${"tx"}`, []);
			}),
		);

		it.effect("runs one statement per sql.unsafe, with or without parameters (postgres.js allowed several)", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				assert.deepStrictEqual(yield* sql.unsafe("select $1::text as x", ["y"]), [{ x: "y" }]);
				assert.strictEqual((yield* sql.unsafe("select 1; select 2").pipe(Effect.flip))._tag, "SqlError");
			}),
		);

		it.effect("fails with a SqlError that keeps the Postgres code", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const error = yield* sql`select * from no_such_table_here`.pipe(Effect.flip);
				assert.strictEqual(error.reason._tag, "SqlSyntaxError");
				assert.strictEqual((error.reason.cause as { code?: string }).code, "42P01");
			}),
		);

		it.effect("shares a pool of at most 10 connections", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* Effect.all(
					Array.from({ length: 25 }, () => sql`select pg_sleep(0.02)`),
					{ concurrency: "unbounded" },
				);
				const stats = yield* sql.poolStats;
				assert.strictEqual(stats.max, 10);
				assert.isAtMost(stats.idle + stats.used, 10);
			}),
		);

		it.effect("names a statement's span as tracing/setup.ts expects, so its sampler drops it", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const names: string[] = [];
				const recording = Tracer.make({ span: (options) => (names.push(options.name), Tracer.nativeTracer.span(options)) });
				yield* sql`select 1`.pipe(Effect.withTracer(recording));
				assert.deepStrictEqual(names, [SQL_STATEMENT_SPAN]);
			}),
		);

		it.effect("answers the health check's ping", () => Database.ping);

		it.effect("drops its table", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql.unsafe(`drop table ${table}`);
			}),
		);
	});
});
