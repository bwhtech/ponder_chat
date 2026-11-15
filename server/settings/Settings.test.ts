/**
 * The app's settings row on a real Postgres (TEST_DATABASE_URL, vitest.config.ts). The
 * row is one for the whole database, so the test keeps the values it found and puts
 * them back at the end.
 */
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PonderConfig from "../config.ts";
import * as Database from "../runtime/Database.ts";
import * as Settings from "./Settings.ts";

const url = process.env.TEST_DATABASE_URL;
const layer = Settings.layer.pipe(
	Layer.provideMerge(Database.layer),
	Layer.provide(PonderConfig.layerFromEnv({ ...(url ? { DATABASE_URL: url } : {}), CHAT_DAILY_CREDITS: "250", CHAT_CREDITS_PER_USD: "2000" })),
);

describe.skipIf(!url)("Settings", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		let found: Settings.AppSettings | undefined;

		it.effect("migrates twice, and fills the row once", () =>
			Effect.gen(function* () {
				const settings = yield* Settings.Settings;
				const sql = yield* PgClient.PgClient;
				yield* settings.migrate;
				yield* settings.migrate;
				const rows = yield* sql<{ count: number }>`select count(*)::int as count from settings`;
				assert.deepStrictEqual(rows, [{ count: 1 }]);
				found = yield* settings.get;
				assert.include(Settings.AUTO_COST_TIERS, found.autoCostTier);
			}),
		);

		it.effect("shows a change at once, and keeps the default compaction model without one", () =>
			Effect.gen(function* () {
				const settings = yield* Settings.Settings;
				const sql = yield* PgClient.PgClient;
				yield* settings.update({ defaultDailyCredits: 321, creditsPerUsd: 1234 }, "test-admin");
				yield* settings.setPdfTextOnServer(false, "test-admin");
				yield* settings.setAutoCostTier("high", "test-admin");
				yield* sql`update settings set compaction_model = null where id = 1`;
				yield* settings.setCompactionModel("z-ai/glm-5.3", "test-admin");
				assert.deepStrictEqual(yield* settings.get, {
					defaultDailyCredits: 321,
					creditsPerUsd: 1234,
					pdfTextOnServer: false,
					compactionModel: "z-ai/glm-5.3",
					autoCostTier: "high",
				});
				// A change made elsewhere shows after the cache's 5 seconds; one made here, at once.
				yield* sql`update settings set compaction_model = null where id = 1`;
				assert.strictEqual((yield* settings.get).compactionModel, "z-ai/glm-5.3");
				yield* settings.setPdfTextOnServer(false, "test-admin");
				assert.strictEqual((yield* settings.get).compactionModel, Settings.DEFAULT_COMPACTION_MODEL);
			}),
		);

		it.effect("puts the values back", () =>
			Effect.gen(function* () {
				const settings = yield* Settings.Settings;
				const sql = yield* PgClient.PgClient;
				const before = found!;
				yield* settings.update(before, "test-admin");
				yield* settings.setPdfTextOnServer(before.pdfTextOnServer, "test-admin");
				yield* settings.setAutoCostTier(before.autoCostTier, "test-admin");
				yield* sql`update settings set compaction_model = ${before.compactionModel === Settings.DEFAULT_COMPACTION_MODEL ? null : before.compactionModel} where id = 1`;
			}),
		);
	});
});
