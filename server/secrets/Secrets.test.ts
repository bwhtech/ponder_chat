/**
 * Secrets: sealing without a database, and the `secrets` table on a real Postgres when
 * TEST_DATABASE_URL is set (vitest.config.ts). The keys come from a config of the test's
 * own, never from the environment.
 */
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PonderConfig from "../config.ts";
import * as Database from "../runtime/Database.ts";
import * as Secrets from "./Secrets.ts";

const AUTH_SECRET = "a-test-secret-that-is-long-enough-for-hkdf";
const url = process.env.TEST_DATABASE_URL;

/** Secrets on a config with these variables. The pool opens a connection only when a query needs one. */
const secretsWith = (env: Record<string, string>) =>
	Secrets.layer.pipe(Layer.provideMerge(Database.layer), Layer.provide(PonderConfig.layerFromEnv({ ...(url ? { DATABASE_URL: url } : {}), ...env })));

const sealed = (env: Record<string, string>, context: string, value: string) =>
	Secrets.Secrets.use((secrets) => secrets.seal(context, value)).pipe(Effect.provide(secretsWith(env)));
const unsealed = (env: Record<string, string>, context: string, stored: string) =>
	Secrets.Secrets.use((secrets) => secrets.unseal(context, stored)).pipe(Effect.provide(secretsWith(env)));

describe("Secrets: sealed values", () => {
	const auth = { BETTER_AUTH_SECRET: AUTH_SECRET };

	it.effect("opens what it sealed, in the same context", () =>
		Effect.gen(function* () {
			const stored = yield* sealed(auth, "mcp_connections:a:credentials", '{"token":"t ✓"}');
			assert.match(stored, /^s1\.a\./);
			assert.notInclude(stored, "token");
			assert.strictEqual(yield* unsealed(auth, "mcp_connections:a:credentials", stored), '{"token":"t ✓"}');
		}),
	);

	it.effect("refuses a value copied to another context", () =>
		Effect.gen(function* () {
			const stored = yield* sealed(auth, "mcp_connections:a:credentials", "secret");
			const error = yield* Effect.flip(unsealed(auth, "mcp_connections:b:credentials", stored));
			assert.instanceOf(error, Secrets.UnreadableSecret);
			assert.strictEqual((error as Secrets.UnreadableSecret).problem, "decrypt");
			assert.strictEqual(error.message, "A saved secret can't be decrypted. Did BETTER_AUTH_SECRET change?");
		}),
	);

	it.effect("uses PONDER_ENCRYPTION_KEY when it is set, and still opens the values sealed before it", () =>
		Effect.gen(function* () {
			const before = yield* sealed(auth, "ctx", "old");
			const withKey = { ...auth, PONDER_ENCRYPTION_KEY: "another-key-that-is-long-enough" };
			const after = yield* sealed(withKey, "ctx", "new");
			assert.match(after, /^s1\.e\./);
			assert.strictEqual(yield* unsealed(withKey, "ctx", before), "old");
			assert.strictEqual(yield* unsealed(withKey, "ctx", after), "new");
			// Without the key, a value sealed with it can't be read, and says which key is missing.
			const error = yield* Effect.flip(unsealed(auth, "ctx", after));
			assert.strictEqual(error.message, "PONDER_ENCRYPTION_KEY is not set, so this secret can't be read.");
		}),
	);

	it.effect("refuses a value that is not in a known format, and a new BETTER_AUTH_SECRET", () =>
		Effect.gen(function* () {
			const format = yield* Effect.flip(unsealed(auth, "ctx", "v1.not.sealed"));
			assert.strictEqual((format as Secrets.UnreadableSecret).problem, "format");
			const stored = yield* sealed(auth, "ctx", "value");
			const changed = yield* Effect.flip(unsealed({ BETTER_AUTH_SECRET: `${AUTH_SECRET}-new` }, "ctx", stored));
			assert.strictEqual((changed as Secrets.UnreadableSecret).problem, "decrypt");
		}),
	);

	it.effect("can't seal without a key", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(sealed({}, "ctx", "value"));
			assert.strictEqual(error.message, "BETTER_AUTH_SECRET is not set, so this secret can't be read.");
		}),
	);
});

describe.skipIf(!url)("Secrets: the secrets table", () => {
	const run = Math.random().toString(36).slice(2, 10);
	const name = `test_secret_${run}`;
	const admin = `test-admin-${run}`;
	let madeUsers = false;

	it.layer(secretsWith({ BETTER_AUTH_SECRET: AUTH_SECRET }), { excludeTestServices: true })((it) => {
		it.effect("saves a secret encrypted, reads it back, and says who saved it", () =>
			Effect.gen(function* () {
				const secrets = yield* Secrets.Secrets;
				const sql = yield* PgClient.PgClient;
				yield* secrets.migrate;
				// The users table is Better Auth's. A test database may not have it: then this test makes one, and drops it at the end.
				const [found] = yield* sql<{ table: string | null }>`select to_regclass('users')::text as table`;
				madeUsers = found?.table == null;
				if (madeUsers) yield* sql`create table users (id text primary key, name text, email text)`;
				yield* sql`insert into users (id, name, email) values (${admin}, '', ${`${admin}@example.invalid`}) on conflict do nothing`;
				assert.deepStrictEqual(yield* secrets.read(name), Option.none());
				assert.deepStrictEqual(yield* secrets.info(name), Option.none());

				yield* secrets.save(name, "sk-or-v1-0123456789abcdef", admin);
				const [row] = yield* sql<{ value: string }>`select value from secrets where name = ${name}`;
				assert.match(row!.value, /^v1\./);
				assert.notInclude(row!.value, "0123456789abcdef");
				assert.deepStrictEqual(yield* secrets.read(name), Option.some("sk-or-v1-0123456789abcdef"));
				const info = yield* secrets.info(name);
				// An empty name falls back to the email.
				assert.isTrue(Option.isSome(info) && info.value.updatedBy === `${admin}@example.invalid` && info.value.updatedAt instanceof Date);
			}),
		);

		it.effect("binds a value to its name", () =>
			Effect.gen(function* () {
				const secrets = yield* Secrets.Secrets;
				const sql = yield* PgClient.PgClient;
				const other = `${name}_moved`;
				yield* sql`insert into secrets (name, value) select ${other}, value from secrets where name = ${name}`;
				const error = yield* Effect.flip(secrets.read(other));
				assert.strictEqual(error._tag, "UnreadableSecret");
				assert.strictEqual(
					(error as Secrets.UnreadableSecret).message,
					`The saved ${other} can't be decrypted. Did BETTER_AUTH_SECRET change? Enter it again in /admin, Settings.`,
				);
				yield* sql`delete from secrets where name in (${name}, ${other})`;
				yield* sql`delete from users where id = ${admin}`;
				if (madeUsers) yield* sql`drop table users`;
			}),
		);
	});
});
