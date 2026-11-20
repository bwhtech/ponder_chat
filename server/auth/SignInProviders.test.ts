/**
 * The sign-in providers' settings on a real Postgres (TEST_DATABASE_URL, vitest.config.ts):
 * what is saved, that the client secret is sealed and never shown, and what sign-in runs on.
 *
 * The test runs in a schema of its own (search_path), which the last test drops.
 */
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PonderConfig from "../config.ts";
import * as Database from "../runtime/Database.ts";
import * as Secrets from "../secrets/Secrets.ts";
import type { MicrosoftSettings } from "./microsoft.ts";
import * as SignInProviders from "./SignInProviders.ts";

const run = Math.random().toString(36).slice(2, 10);
const schema = `test_sign_in_${run}`;
const base = process.env.TEST_DATABASE_URL;
const url = base && `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`;

const providersLayer = (secret: string) =>
	SignInProviders.layer.pipe(
		Layer.provideMerge(Secrets.layer),
		Layer.provideMerge(Database.layer),
		Layer.provide(PonderConfig.layerFromEnv({ ...(url ? { DATABASE_URL: url } : {}), BETTER_AUTH_SECRET: secret })),
	);

const SECRET = "Abc8Q~the-client-secret-value";
const settings: MicrosoftSettings = {
	enabled: true,
	tenantId: "11111111-2222-4333-8444-555555555555",
	clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
	signUps: "everyone",
	allowedDomains: ["example.org"],
};

describe.skipIf(!base)("SignInProviders", () => {
	it.layer(providersLayer("test-secret-for-sign-in-providers-0123456789"), { excludeTestServices: true })((it) => {
		it.effect("has nothing set up on a database with no table, and after it is made", () =>
			Effect.gen(function* () {
				const providers = yield* SignInProviders.SignInProviders;
				const sql = yield* PgClient.PgClient;
				yield* sql`create schema ${sql.literal(schema)}`;
				assert.isFalse((yield* providers.microsoft).enabled);
				yield* providers.migrate;
				yield* providers.migrate;
				assert.deepStrictEqual(yield* providers.microsoft, {
					enabled: false,
					tenantId: "",
					clientId: "",
					signUps: "invited",
					allowedDomains: [],
					hasSecret: false,
					secretUnreadable: false,
					updatedAt: null,
				});
				// Better Auth's table of linked accounts, as far as this service reads it.
				yield* sql`create table accounts (id text primary key, "userId" text not null, "providerId" text not null, "accountId" text not null)`;
				assert.isTrue(Option.isNone((yield* providers.active).microsoft));
			}),
		);

		it.effect("saves nothing that is not complete", () =>
			Effect.gen(function* () {
				const providers = yield* SignInProviders.SignInProviders;
				const refused = yield* Effect.flip(providers.saveMicrosoft(settings, undefined, "admin"));
				assert.strictEqual(refused._tag, "InvalidSettings");
				assert.strictEqual(refused.message, "Enter the client secret.");
				assert.isFalse((yield* providers.microsoft).enabled);
			}),
		);

		it.effect("seals the client secret, and shows only that there is one", () =>
			Effect.gen(function* () {
				const providers = yield* SignInProviders.SignInProviders;
				const sql = yield* PgClient.PgClient;
				const before = (yield* providers.active).version;
				const status = yield* providers.saveMicrosoft(settings, `  ${SECRET} `, "admin");
				assert.deepStrictEqual({ ...status, updatedAt: null }, { ...settings, hasSecret: true, secretUnreadable: false, updatedAt: null });
				assert.notInclude(JSON.stringify(status), SECRET);
				const [row] = yield* sql<{ client_secret: string; updated_by: string }>`select client_secret, updated_by from sign_in_providers where id = 'microsoft'`;
				assert.notInclude(row?.client_secret ?? "", SECRET);
				assert.match(row?.client_secret ?? "", /^s1\./);
				assert.strictEqual(row?.updated_by, "admin");
				// What sign-in runs on has the secret, and a new version, so Better Auth is made again.
				const active = yield* providers.active;
				assert.isAbove(active.version, before);
				assert.deepStrictEqual(Option.getOrThrow(active.microsoft), { tenantId: settings.tenantId, clientId: settings.clientId, clientSecret: SECRET, signUps: "everyone", allowedDomains: ["example.org"] });
			}),
		);

		it.effect("keeps the saved secret when a change brings none", () =>
			Effect.gen(function* () {
				const providers = yield* SignInProviders.SignInProviders;
				const status = yield* providers.saveMicrosoft({ ...settings, signUps: "invited", allowedDomains: ["example.org", "example.com"] }, undefined, "admin");
				assert.isTrue(status.hasSecret);
				const active = Option.getOrThrow((yield* providers.active).microsoft);
				assert.strictEqual(active.clientSecret, SECRET);
				assert.strictEqual(active.signUps, "invited");
				assert.deepStrictEqual(active.allowedDomains, ["example.org", "example.com"]);
			}),
		);

		it.effect("runs on nothing while it is off, with the settings kept", () =>
			Effect.gen(function* () {
				const providers = yield* SignInProviders.SignInProviders;
				const status = yield* providers.saveMicrosoft({ ...settings, enabled: false }, undefined, "admin");
				assert.isFalse(status.enabled);
				assert.strictEqual(status.tenantId, settings.tenantId);
				assert.isTrue(Option.isNone((yield* providers.active).microsoft));
				yield* providers.saveMicrosoft(settings, undefined, "admin");
				assert.isTrue(Option.isSome((yield* providers.active).microsoft));
			}),
		);

		it.effect("unlinks one person, and everyone when the tenant changes", () =>
			Effect.gen(function* () {
				const providers = yield* SignInProviders.SignInProviders;
				const sql = yield* PgClient.PgClient;
				yield* sql`insert into accounts (id, "userId", "providerId", "accountId") values ('a1', 'ana', 'microsoft', 'oid-ana'), ('a2', 'bo', 'microsoft', 'oid-bo'), ('a3', 'bo', 'other', 'x')`;
				assert.isTrue(yield* providers.isLinked("ana"));
				assert.isTrue(yield* providers.unlink("ana"));
				assert.isFalse(yield* providers.unlink("ana"));
				assert.isFalse(yield* providers.isLinked("ana"));
				assert.isTrue(yield* providers.isLinked("bo"));
				// The same tenant again: the links stay.
				yield* providers.saveMicrosoft({ ...settings, signUps: "invited" }, undefined, "admin");
				assert.isTrue(yield* providers.isLinked("bo"));
				// Another tenant: its accounts are other accounts.
				yield* providers.saveMicrosoft({ ...settings, tenantId: "99999999-2222-4333-8444-555555555555" }, undefined, "admin");
				assert.isFalse(yield* providers.isLinked("bo"));
				assert.deepStrictEqual(yield* sql`select id from accounts`, [{ id: "a3" }]);
				yield* providers.saveMicrosoft(settings, undefined, "admin");
			}),
		);

		it.effect("turns sign-in by email off while Microsoft is on, and keeps it off", () =>
			Effect.gen(function* () {
				const providers = yield* SignInProviders.SignInProviders;
				assert.isTrue((yield* providers.active).email);
				const before = (yield* providers.active).version;
				assert.isFalse(yield* providers.saveEmail(false, "admin"));
				const active = yield* providers.active;
				assert.isAbove(active.version, before);
				assert.isFalse(active.email);
				assert.isTrue(Option.isSome(active.microsoft));
			}),
		);
	});

	// As after BETTER_AUTH_SECRET changed: the saved secret no longer opens.
	it.layer(providersLayer("another-secret-than-the-one-that-sealed-0123456789"), { excludeTestServices: true })((it) => {
		it.effect("turns Microsoft off when its client secret can't be read, and takes a new one", () =>
			Effect.gen(function* () {
				const providers = yield* SignInProviders.SignInProviders;
				const status = yield* providers.microsoft;
				assert.isTrue(status.enabled && status.hasSecret && status.secretUnreadable);
				assert.isTrue(Option.isNone((yield* providers.active).microsoft));
				// Email was off: with Microsoft not working, it is on, whatever its setting says.
				assert.isTrue((yield* providers.active).email);
				assert.strictEqual((yield* Effect.flip(providers.saveEmail(false, "admin")))._tag, "EmailNeeded");
				// It can't be kept on with a secret that does not open: Settings asks for it again.
				const refused = yield* Effect.flip(providers.saveMicrosoft(settings, undefined, "admin"));
				assert.strictEqual(refused.message, "Enter the client secret.");
				assert.isFalse((yield* providers.saveMicrosoft(settings, SECRET, "admin")).secretUnreadable);
				assert.strictEqual(Option.getOrThrow((yield* providers.active).microsoft).clientSecret, SECRET);
				// Microsoft works again, and email's setting was kept: off.
				assert.isFalse((yield* providers.active).email);
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
