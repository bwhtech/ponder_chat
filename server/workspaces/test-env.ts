import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import type * as Statement from "effect/sql/Statement";

/**
 * The environment of the workspace tests (*.test.ts here): the app's layer on
 * TEST_DATABASE_URL, in a schema of the test's own (search_path), with memory, Python and
 * OpenRouter off. Import it before the app's modules: the layer reads the environment when
 * it is built (config.ts). The users table there is a small one of the test's own, as in
 * people/Invites.test.ts. `public` comes after it on the path only for pgvector's type and
 * operators, which the extension put there: every table is made in the test's schema.
 */
export const base = process.env.TEST_DATABASE_URL;

export function useTestSchema(schema: string) {
	if (!base) return;
	Object.assign(process.env, {
		DATABASE_URL: `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema},public`)}`,
		BETTER_AUTH_SECRET: "test-secret-for-the-workspaces-0123456789abcdef",
		PONDER_MEMORY: "off",
		PONDER_PYTHON: "off",
		OPENROUTER_API_KEY: "sk-or-v1-test",
		// Nothing answers here: the title and the models list fail at once, and are logged.
		OPENROUTER_BASE_URL: "http://127.0.0.1:9/api",
	});
}

/** Better Auth's users, with only the columns Ponder reads. */
export const USERS_TABLE = `create table users (
	id text primary key, name text, email text not null, role text, banned boolean,
	"createdAt" timestamptz not null default now(), "updatedAt" timestamptz not null default now()
)`;

/**
 * The session that the session `pid` blocks, once one waits for it: a barrier for tests of
 * two transactions at once. Postgres gives no event when a session starts to wait for a
 * lock, so this asks it every 10 ms, for 10 seconds at most.
 */
export const blockedBy = (sql: PgClient.PgClient, pid: number) =>
	sql<{ pid: number }>`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`.pipe(
		Effect.map((rows) => rows[0]?.pid),
		Effect.repeat({ until: (found) => found !== undefined, schedule: Schedule.spaced("10 millis") }),
		Effect.timeout("10 seconds"),
		Effect.map((found) => found!),
		Effect.orDie,
	);

/**
 * Locks rows in a transaction of its own until `release`: the test's way to stop another
 * transaction half-way, at the first of these rows it needs. Gives the session's pid.
 */
export const holdRows = Effect.fnUntraced(function* (sql: PgClient.PgClient, lock: Statement.Statement<unknown>) {
	const pid = yield* Deferred.make<number>();
	const release = yield* Deferred.make<void>();
	const fiber = yield* Effect.forkChild(
		sql.withTransaction(
			Effect.gen(function* () {
				const [session] = yield* sql<{ pid: number }>`select pg_backend_pid() as pid`;
				yield* lock;
				yield* Deferred.succeed(pid, session.pid);
				yield* Deferred.await(release);
			}),
		).pipe(Effect.orDie),
	);
	return { pid: yield* Deferred.await(pid), release: Effect.andThen(Deferred.succeed(release, undefined), Fiber.join(fiber)) };
});
