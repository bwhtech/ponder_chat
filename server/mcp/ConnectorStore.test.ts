/**
 * The connectors repository on a real Postgres. Runs when TEST_DATABASE_URL is set
 * (vitest.config.ts). The test runs in a schema of its own (search_path), with a small
 * `users` table of its own for the connections to reference, and the last test drops the
 * schema: other test files make their own `users`, or use Better Auth's.
 */
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PonderConfig from "../config.ts";
import * as Database from "../runtime/Database.ts";
import * as Secrets from "../secrets/Secrets.ts";
import * as ConnectorStore from "./ConnectorStore.ts";
import type { NewConnection } from "./ConnectorStore.ts";

const run = Math.random().toString(36).slice(2, 10);
const schema = `test_connectors_${run}`;
const base = process.env.TEST_DATABASE_URL;
const url = base && `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`;
const layer = ConnectorStore.layer.pipe(
	Layer.provideMerge(Secrets.layer),
	Layer.provideMerge(Database.layer),
	Layer.provide(PonderConfig.layerFromEnv({ ...(url ? { DATABASE_URL: url } : {}), BETTER_AUTH_SECRET: "a-test-secret-that-is-long-enough-for-hkdf" })),
);

const person = `test-connectors-${run}`;
const other = `test-connectors-other-${run}`;

const tool = { name: "echo", title: "Echo", description: "Repeats.", inputSchema: { type: "object" }, readOnly: true, destructive: false };
const draft = (input: Partial<NewConnection> = {}): NewConnection => ({
	userId: person,
	name: "Shop",
	slug: "shop",
	url: `https://shop-${run}.example/mcp`,
	transport: "http",
	auth: "none",
	oauthClientId: null,
	credentials: {},
	serverInfo: { name: "shop", title: "Shop Server" },
	tools: [tool],
	...input,
});

describe.skipIf(!base)("ConnectorStore", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("migrates, with the two people the tests use", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`create schema ${sql.literal(schema)}`;
				// The part of `users` that the connections reference.
				yield* sql`create table users (id text primary key, name text not null, email text not null)`;
				for (const id of [person, other]) yield* sql`insert into users (id, name, email) values (${id}, 'Connector test', ${`${id}@example.invalid`})`;
				const store = yield* ConnectorStore.ConnectorStore;
				yield* store.migrate;
				yield* store.migrate;
			}),
		);

		it.effect("saves a connection and reads it back, with no headers and with a key", () =>
			Effect.gen(function* () {
				const store = yield* ConnectorStore.ConnectorStore;
				const open = Option.getOrThrow(yield* store.insertConnection(draft()));
				assert.deepStrictEqual(open.headerNames, []);
				assert.deepStrictEqual(open.tools, [tool]);
				assert.deepStrictEqual(open.serverInfo, { name: "shop", title: "Shop Server" });
				assert.deepStrictEqual(open.toolRules, {});
				assert.isTrue(open.createdAt instanceof Date && open.toolsCheckedAt instanceof Date);
				assert.deepStrictEqual(yield* store.readCredentials(open), {});

				const keyed = Option.getOrThrow(
					yield* store.insertConnection(draft({ slug: "key", url: `https://key-${run}.example/mcp`, auth: "headers", credentials: { headers: { "x-api-key": "k ✓" } }, serverInfo: null })),
				);
				assert.deepStrictEqual(keyed.headerNames, ["x-api-key"]);
				assert.isNull(keyed.serverInfo);
				assert.notInclude(keyed.sealed ?? "", "k ✓");
				assert.deepStrictEqual(yield* store.readCredentials(keyed), { headers: { "x-api-key": "k ✓" } });

				// The same URL or slug again is none.
				assert.isTrue(Option.isNone(yield* store.insertConnection(draft())));
				assert.isTrue(yield* store.hasConnectionTo(person, draft().url));
				assert.deepStrictEqual(yield* store.takenSlugs(person), new Set(["shop", "key"]));
				assert.deepStrictEqual((yield* store.listConnections(person)).map((each) => each.slug), ["shop", "key"]);
				assert.deepStrictEqual((yield* store.connectionsForReply(person)).map((each) => each.slug), ["key", "shop"]);
			}),
		);

		it.effect("keeps one person's connections from another", () =>
			Effect.gen(function* () {
				const store = yield* ConnectorStore.ConnectorStore;
				const [mine] = yield* store.listConnections(person);
				assert.isTrue(Option.isNone(yield* store.getConnection(mine!.id, other)));
				assert.isTrue(Option.isNone(yield* store.updateConnection(mine!.id, other, { enabled: false })));
				assert.isFalse(yield* store.deleteConnection(mine!.id, other));
				assert.deepStrictEqual(yield* store.listConnections(other), []);
			}),
		);

		it.effect("changes only what a patch or a status names", () =>
			Effect.gen(function* () {
				const store = yield* ConnectorStore.ConnectorStore;
				const [mine] = yield* store.listConnections(person);
				const renamed = Option.getOrThrow(yield* store.updateConnection(mine!.id, person, { name: "Shop 2" }));
				assert.strictEqual(renamed.name, "Shop 2");
				assert.isTrue(renamed.enabled);
				const ruled = Option.getOrThrow(yield* store.updateConnection(mine!.id, person, { toolRules: { echo: "off" } }));
				assert.deepStrictEqual(ruled.toolRules, { echo: "off" });
				assert.strictEqual(ruled.name, "Shop 2");

				yield* store.setStatus(mine!.id, "error", "down");
				// New credentials without a status keep the status and the error.
				yield* store.saveCredentials(mine!.id, { headers: { a: "b" } });
				let read = Option.getOrThrow(yield* store.getConnection(mine!.id, person));
				assert.deepStrictEqual([read.status, read.lastError, read.headerNames], ["error", "down", ["a"]]);
				yield* store.saveCredentials(mine!.id, { tokens: { access_token: "t", token_type: "Bearer", expires_at: 1_700_000_000_000 } as never }, { status: "connected" });
				read = Option.getOrThrow(yield* store.getConnection(mine!.id, person));
				assert.deepStrictEqual([read.status, read.lastError, read.headerNames], ["connected", null, []]);
				assert.strictEqual(read.expiresAt?.getTime(), 1_700_000_000_000);
				yield* store.setLastError(mine!.id, "slow");
				yield* store.markUsed(mine!.id);
				read = Option.getOrThrow(yield* store.getConnection(mine!.id, person));
				assert.deepStrictEqual([read.status, read.lastError], ["connected", "slow"]);
				assert.isTrue(read.lastUsedAt instanceof Date);
				yield* store.saveTools(mine!.id, [], null);
				read = Option.getOrThrow(yield* store.getConnection(mine!.id, person));
				assert.deepStrictEqual([read.tools, read.serverInfo, read.lastError], [[], null, null]);
			}),
		);

		it.effect("gives the failed connections to retry once they waited", () =>
			Effect.gen(function* () {
				const store = yield* ConnectorStore.ConnectorStore;
				const [mine] = yield* store.listConnections(person);
				yield* store.setStatus(mine!.id, "error", "down");
				assert.deepStrictEqual(yield* store.connectionsToRetry(person, 5 * 60_000), []);
				const sql = yield* PgClient.PgClient;
				yield* sql`update mcp_connections set updated_at = now() - interval '6 minutes' where id = ${mine!.id}`;
				assert.deepStrictEqual((yield* store.connectionsToRetry(person, 5 * 60_000)).map((each) => each.id), [mine!.id]);
			}),
		);

		it.effect("a sign-in's state works once, and only for the person who started it", () =>
			Effect.gen(function* () {
				const store = yield* ConnectorStore.ConnectorStore;
				const secret = { verifier: "v", redirectUrl: "http://localhost/cb", credentials: { client: { client_id: "c" } }, draft: { name: "S", url: "https://s.example/mcp", transport: "http" as const, oauthClientId: null } };
				yield* store.saveSignIn(`state-${run}`, person, null, secret);
				assert.isTrue(Option.isNone(yield* store.takeSignIn(`state-${run}`, other)));
				assert.deepStrictEqual(yield* store.takeSignIn(`state-${run}`, person), Option.some({ connectionId: null, secret }));
				assert.isTrue(Option.isNone(yield* store.takeSignIn(`state-${run}`, person)));
				// An expired one is none.
				yield* store.saveSignIn(`old-${run}`, person, null, secret);
				const sql = yield* PgClient.PgClient;
				yield* sql`update mcp_sign_ins set expires_at = now() - interval '1 minute' where state_hash = ${ConnectorStore.hashState(`old-${run}`)}`;
				assert.isTrue(Option.isNone(yield* store.takeSignIn(`old-${run}`, person)));
			}),
		);

		it.effect("deletes a connection, with the person's sign-ins, then the test's schema", () =>
			Effect.gen(function* () {
				const store = yield* ConnectorStore.ConnectorStore;
				const [mine] = yield* store.listConnections(person);
				assert.isTrue(yield* store.deleteConnection(mine!.id, person));
				const sql = yield* PgClient.PgClient;
				yield* sql`delete from users where id = ${person}`;
				assert.deepStrictEqual(yield* store.listConnections(person), []);
				yield* sql`drop schema ${sql.literal(schema)} cascade`;
			}),
		);
	});
});
