/**
 * The admin activity log on a real Postgres (TEST_DATABASE_URL, vitest.config.ts): what an
 * event holds, the pages, the filter by person, and a write that fails without failing
 * the admin's change. The test's events have actors of its own, and the last test deletes them.
 */
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PonderConfig from "../config.ts";
import * as Database from "../runtime/Database.ts";
import * as AdminEvents from "./AdminEvents.ts";

const url = process.env.TEST_DATABASE_URL;
const lines: string[] = [];
const logger = Logger.make(({ message }) => lines.push((Array.isArray(message) ? message : [message]).join(" ")));
const layer = AdminEvents.layer.pipe(
	Layer.provideMerge(Database.layer),
	Layer.provide(PonderConfig.layerFromEnv(url ? { DATABASE_URL: url } : {})),
	Layer.provideMerge(Logger.layer([logger])),
);

const run = Math.random().toString(36).slice(2, 10);
const admin = { id: `test-admin-${run}`, email: `admin-${run}@example.invalid` };
const ana = `test-ana-${run}`;
const invited = `invited-${run}@example.invalid`;

describe.skipIf(!url)("AdminEvents", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("migrates twice without a change", () =>
			Effect.gen(function* () {
				const events = yield* AdminEvents.AdminEvents;
				yield* events.migrate;
				yield* events.migrate;
			}),
		);

		it.effect("records who did what to whom, with what changed", () =>
			Effect.gen(function* () {
				const events = yield* AdminEvents.AdminEvents;
				yield* events.record({ actor: admin, action: "set-daily-credits", target: ana, before: { dailyCredits: null }, after: { dailyCredits: 3000 } });
				yield* events.record({ actor: admin, action: "invite", target: invited, after: { note: "Pilot ✓", dailyCredits: null, emailed: false } });
				yield* events.record({ actor: admin, action: "update-settings" });
				const [settings, invite, credits] = yield* events.list({ people: [admin.id], limit: 10 });
				assert.deepInclude(settings, { actor_id: admin.id, actor_email: admin.email, action: "update-settings", target: null, before: null, after: null });
				assert.deepInclude(invite, { action: "invite", target: invited, before: null, after: { note: "Pilot ✓", dailyCredits: null, emailed: false } });
				assert.deepInclude(credits, { action: "set-daily-credits", target: ana, before: { dailyCredits: null }, after: { dailyCredits: 3000 } });
				assert.instanceOf(credits!.at, Date);
				assert.isTrue(settings!.id > invite!.id && invite!.id > credits!.id);
			}),
		);

		it.effect("pages newest first, and finds events by either side", () =>
			Effect.gen(function* () {
				const events = yield* AdminEvents.AdminEvents;
				const [first, second, third] = yield* events.list({ people: [admin.id], limit: 3 });
				assert.deepStrictEqual(
					(yield* events.list({ people: [admin.id], limit: 2, olderThan: first!.id })).map((row) => row.id),
					[second!.id, third!.id],
				);
				assert.deepStrictEqual(yield* events.list({ people: [admin.id], limit: 2, olderThan: third!.id }), []);
				assert.deepStrictEqual(
					(yield* events.list({ people: [ana], limit: 10 })).map((row) => row.action),
					["set-daily-credits"],
				);
				assert.deepStrictEqual(
					(yield* events.list({ people: [invited, `nobody-${run}`], limit: 10 })).map((row) => row.action),
					["invite"],
				);
				assert.isAtLeast((yield* events.list({ limit: 3 })).length, 3);
			}),
		);

		it.effect("logs a write that fails, and does not fail", () =>
			Effect.gen(function* () {
				const events = yield* AdminEvents.AdminEvents;
				lines.length = 0;
				// JSON can't hold a bigint: the write fails before it reaches the database.
				yield* events.record({ actor: admin, action: "grant-credits", target: ana, after: { credits: 1n } });
				assert.deepStrictEqual(lines.length, 1);
				assert.match(lines[0]!, new RegExp(`^admin-events: could not record grant-credits by ${admin.email}: `));
				assert.deepStrictEqual((yield* events.list({ people: [ana], limit: 10 })).map((row) => row.action), ["set-daily-credits"]);
			}),
		);

		it.effect("deletes the test's events", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`delete from admin_events where actor_id = ${admin.id}`;
			}),
		);
	});
});
