/**
 * Invites on a real Postgres (TEST_DATABASE_URL, vitest.config.ts): who may sign in, the
 * limit an invite gives a new account, and the emails that are taken.
 *
 * The test runs in a schema of its own (search_path), which the last test drops: the
 * users table is Better Auth's, and other test files make and drop a smaller one of their
 * own at the same time.
 */
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PonderConfig from "../config.ts";
import * as Credits from "../credits/Credits.ts";
import * as ExtraCredits from "../credits/ExtraCredits.ts";
import * as Notify from "../notify/Notify.ts";
import * as Database from "../runtime/Database.ts";
import * as Http from "../runtime/Http.ts";
import * as Settings from "../settings/Settings.ts";
import { migrateTeams } from "../teams/tables.ts";
import * as Accounts from "./Accounts.ts";
import * as Invites from "./Invites.ts";

const run = Math.random().toString(36).slice(2, 10);
const schema = `test_invites_${run}`;
const base = process.env.TEST_DATABASE_URL;
const url = base && `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`;
const fromEnv = `env-${run}@example.invalid`;
const invitesLayer = (env: Record<string, string>) =>
	Layer.mergeAll(Invites.layer, Accounts.layer, Credits.layer).pipe(
		Layer.provideMerge(Layer.mergeAll(ExtraCredits.layer, Settings.layer, Notify.layer)),
		Layer.provideMerge(Layer.mergeAll(Database.layer, Http.layer)),
		Layer.provide(PonderConfig.layerFromEnv({ ...(url ? { DATABASE_URL: url } : {}), ...env })),
	);

const ana = `Ana-${run}@Example.invalid`;
const anaId = `test-ana-${run}`;

describe.skipIf(!base)("Invites", () => {
	it.layer(invitesLayer({ CHAT_ALLOWED_EMAILS: ` ${fromEnv.toUpperCase()} , ` }), { excludeTestServices: true })((it) => {
		it.effect("migrates twice without a change", () =>
			Effect.gen(function* () {
				const invites = yield* Invites.Invites;
				const sql = yield* PgClient.PgClient;
				yield* sql`create schema ${sql.literal(schema)}`;
				yield* invites.migrate;
				yield* invites.migrate;
				yield* Credits.Credits.use((credits) => credits.migrate);
				yield* sql`create table users (id text primary key, name text, email text, role text, "createdAt" timestamptz not null default now(), "updatedAt" timestamptz not null default now())`;
				// disallow cancels team invites too. Their workspace grants need a workspaces table.
				yield* sql`create table workspaces (id text primary key)`;
				yield* migrateTeams(sql);
			}),
		);

		it.effect("lets in invited emails, whatever their case, and those of CHAT_ALLOWED_EMAILS", () =>
			Effect.gen(function* () {
				const invites = yield* Invites.Invites;
				assert.isFalse(yield* invites.isAllowed(ana));
				yield* invites.allow(` ${ana} `, { note: "Pilot", dailyCredits: 3000, invitedBy: "test-admin" });
				assert.isTrue(yield* invites.isAllowed(ana.toUpperCase()));
				assert.isTrue(yield* invites.invited(ana.toLowerCase()));
				assert.isTrue(yield* invites.isAllowed(fromEnv));
				assert.isFalse(yield* invites.invited(fromEnv));
				assert.deepStrictEqual(yield* invites.inviteCredits(ana.toLowerCase()), Option.some(3000));
				// A second invite keeps the limit and changes the note.
				yield* invites.allow(ana, { note: "Group 2", dailyCredits: 10 });
				assert.deepStrictEqual(yield* invites.inviteCredits(ana.toLowerCase()), Option.some(3000));
				const row = (yield* invites.list).find((one) => one.email === ana.toLowerCase());
				assert.strictEqual(row?.note, "Group 2");
			}),
		);

		it.effect("gives a new account the limit of its invite, once", () =>
			Effect.gen(function* () {
				const invites = yield* Invites.Invites;
				const accounts = yield* Accounts.Accounts;
				const sql = yield* PgClient.PgClient;
				const waiting = yield* invites.waiting;
				assert.deepStrictEqual(yield* invites.taken([ana.toLowerCase(), `free-${run}@example.invalid`]), [ana.toLowerCase()]);
				yield* sql`insert into users (id, name, email, role) values (${anaId}, 'Ana', ${ana}, 'user')`;
				assert.strictEqual(yield* invites.waiting, waiting - 1);
				yield* invites.applyInvite({ id: anaId, email: ana });
				assert.deepStrictEqual(yield* Credits.Credits.use((credits) => credits.ownLimit(anaId)), Option.some(3000));
				yield* invites.setInviteCredits(ana, 5);
				yield* invites.applyInvite({ id: anaId, email: ana });
				assert.deepStrictEqual(yield* Credits.Credits.use((credits) => credits.ownLimit(anaId)), Option.some(3000));

				// The account, by id or by email, and its role.
				assert.isTrue(yield* accounts.hasAccount(anaId));
				assert.isTrue(yield* accounts.hasAccount(ana.toUpperCase()));
				assert.deepStrictEqual(yield* accounts.idOfEmail(` ${ana.toUpperCase()} `), Option.some(anaId));
				assert.deepStrictEqual(yield* accounts.emailOf(anaId), Option.some(ana));
				assert.strictEqual(yield* accounts.roleOf(anaId), "user");
				assert.isTrue(yield* accounts.setRole(ana.toUpperCase(), "admin"));
				assert.isTrue(yield* accounts.isAdmin(anaId));
				assert.isTrue((yield* accounts.listAdmins).some((one) => one.email === ana));
				assert.isFalse(yield* accounts.setRole(`nobody-${run}@example.invalid`, "admin"));
				assert.strictEqual(yield* accounts.roleOf(`nobody-${run}`), "user");
			}),
		);

		it.effect("takes back an invite", () =>
			Effect.gen(function* () {
				const invites = yield* Invites.Invites;
				assert.deepStrictEqual(yield* invites.disallow(ana.toUpperCase()), { invited: true, teamInvites: [] });
				assert.deepStrictEqual(yield* invites.disallow(ana), { invited: false, teamInvites: [] });
				assert.isFalse(yield* invites.isAllowed(ana));
				assert.isFalse(yield* invites.setInviteCredits(ana, 5));
				assert.deepStrictEqual(yield* invites.inviteCredits(ana.toLowerCase()), Option.none());
			}),
		);

		it.effect("drops the test's schema", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`drop schema ${sql.literal(schema)} cascade`;
			}),
		);
	});

	it.layer(invitesLayer({ CHAT_OPEN_SIGNUP: "1" }), { excludeTestServices: true })((it) => {
		it.effect("lets anyone in with CHAT_OPEN_SIGNUP=1", () =>
			Effect.gen(function* () {
				assert.isTrue(yield* Invites.Invites.use((invites) => invites.isAllowed(`anyone-${run}@example.invalid`)));
			}),
		);
	});
});
