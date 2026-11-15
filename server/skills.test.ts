/**
 * Skills on a real Postgres (TEST_DATABASE_URL): ids come back as numbers (the column is
 * a bigserial), a taken name and a stale copy are refused with their answers, and a
 * change shows in the active skills at once. Skills are one list for the whole database,
 * so the test names its skills with a random prefix and deletes them at the end.
 */
import { randomBytes } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PonderConfig from "./config.ts";
import * as Database from "./runtime/Database.ts";
import * as Skills from "./skills.ts";

const url = process.env.TEST_DATABASE_URL;
const layer = Skills.layer.pipe(Layer.provideMerge(Database.layer), Layer.provide(PonderConfig.layerFromEnv(url ? { DATABASE_URL: url } : {})));

const prefix = `t${randomBytes(4).toString("hex")}`;
const input = (name: string, extra: Partial<Skills.SkillInput> = {}): Skills.SkillInput => ({
	name: `${prefix}-${name}`,
	description: "Use it when the test asks for it.",
	automatic: true,
	enabled: true,
	body: "Do what the test says.",
	...extra,
});

describe.skipIf(!url)("Skills", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("saves, refuses a taken name and a stale copy, and shows changes at once", () =>
			Effect.gen(function* () {
				const skills = yield* Skills.Skills;
				const sql = yield* PgClient.PgClient;
				// On a database without Ponder's tables, the part of Better Auth's `users` that the list joins
				// for the editor's name. Loose, so the other tests that write to it still can.
				yield* sql`create table if not exists users (id text primary key, name text, email text, "emailVerified" boolean)`;
				yield* skills.migrate;

				const created = yield* skills.save(input("first"), "admin-test");
				assert.isTrue(created.ok);
				if (!created.ok) return;
				assert.isNumber(created.skill.id);
				assert.strictEqual(created.skill.body, "Do what the test says.");
				assert.include((yield* skills.active).map((skill) => skill.name), `${prefix}-first`);

				const taken = yield* skills.save(input("first"), "admin-test");
				assert.deepStrictEqual(taken, { ok: false, status: 409, error: `Another skill is named ${prefix}-first.` });

				const stale = yield* skills.save({ ...input("first"), id: created.skill.id, expectedUpdatedAt: "2001-01-01T00:00:00.000Z" }, "admin-test");
				assert.isFalse(stale.ok);
				if (!stale.ok) assert.strictEqual(stale.status, 409);
				const fresh = yield* skills.save({ ...input("first", { description: "Changed." }), id: created.skill.id, expectedUpdatedAt: created.skill.updatedAt }, "admin-test");
				assert.isTrue(fresh.ok);

				assert.strictEqual(yield* skills.setEnabled(created.skill.id, false, "admin-test"), "ok");
				assert.notInclude((yield* skills.active).map((skill) => skill.name), `${prefix}-first`);
				assert.deepStrictEqual(
					(yield* skills.list).filter((skill) => skill.name === `${prefix}-first`).map((skill) => [skill.id, skill.enabled]),
					[[created.skill.id, false]],
				);

				assert.isTrue(yield* skills.remove(created.skill.id, "admin-test"));
				assert.isTrue(Option.isNone(yield* skills.get(created.skill.id)));
				assert.strictEqual(yield* skills.setEnabled(created.skill.id, true, "admin-test"), "missing");
				const gone = yield* skills.save({ ...input("first"), id: created.skill.id }, "admin-test");
				assert.isFalse(gone.ok);
				if (!gone.ok) assert.strictEqual(gone.status, 404);
				yield* sql`delete from skills where name like ${`${prefix}-%`}`;
			}),
		);
	});
});
