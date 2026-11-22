/**
 * A person's usage on a real Postgres (TEST_DATABASE_URL, vitest.config.ts), in a schema of
 * its own (search_path), which the last test drops, as in Credits.test.ts.
 */
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PonderConfig from "../config.ts";
import * as Database from "../runtime/Database.ts";
import * as Settings from "../settings/Settings.ts";
import * as Runs from "../telemetry/Runs.ts";
import { creditUsage } from "./CreditUsage.ts";

const run = Math.random().toString(36).slice(2, 10);
const schema = `test_credit_usage_${run}`;
const base = process.env.TEST_DATABASE_URL;
const url = base && `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`;
const layer = Layer.mergeAll(Runs.layer, Settings.layer).pipe(
	Layer.provideMerge(Database.layer),
	Layer.provide(PonderConfig.layerFromEnv({ ...(url ? { DATABASE_URL: url } : {}), CHAT_CREDITS_PER_USD: "1000" })),
);

const ana = `test-ana-${run}`;
const ben = `test-ben-${run}`;

const charged = (user: string, model: string, costUsd: string) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		yield* sql`
			insert into runs (id, "user", function_id, model, steps, input_tokens, output_tokens, cached_tokens, cost_usd, duration_ms, finish_reason)
			values (${`${user}-${Math.random()}`}, ${user}, 'chat', ${model}, 1, 1, 1, 0, ${costUsd}::numeric, 1, 'stop')`;
	});

describe.skipIf(!base)("CreditUsage", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("leaves out another person's runs", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`create schema ${sql.literal(schema)}`;
				yield* Runs.Runs.use((runs) => runs.migrate);
				yield* Settings.Settings.use((settings) => settings.migrate);
				yield* charged(ana, "test/ana-model", "0.002");
				yield* charged(ben, "test/ben-model", "0.5");

				const usage = yield* creditUsage(ana);
				assert.strictEqual(usage.total, 2);
				assert.deepStrictEqual(usage.models, [{ model: "test/ana-model", credits: 2 }]);
				assert.strictEqual(usage.days.at(-1)?.credits, 2);
			}),
		);

		it.effect("drops the test's schema", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`drop schema ${sql.literal(schema)} cascade`;
			}),
		);
	});
});
