import * as PgClient from "@effect/sql-pg/PgClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { SqlError } from "effect/sql/SqlError";
import * as PonderConfig from "../config.ts";

/**
 * Ponder's Postgres for Effect code: one pool, `PgClient` (which is also `SqlClient`),
 * through @effect/sql-pg's own Postgres protocol. docs/effect.md, "Database", says why
 * this client and what differs from postgres.js.
 *
 * The same size as postgres.js's pool (10) and the same connect timeout (30 seconds).
 * Connections open when a query needs one, so the layer builds with Postgres down, as the
 * old pool did. Notices ("already exists, skipping" from the migrations) are dropped by
 * the client, as `onnotice: () => {}` did.
 *
 * Until Phase 3, db.ts's postgres.js pool runs next to this one, for the modules not on
 * Effect yet: two pools, up to 20 connections.
 */
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const config = yield* PonderConfig.PonderConfig;
		return PgClient.layer({
			url: Option.getOrUndefined(config.databaseUrl),
			maxConnections: 10,
			connectTimeout: Duration.seconds(30),
			// postgres.js read a row of any size, and a thread's messages are one jsonb value
			// that can pass the client's default of 16 MiB. Postgres caps a value at 1 GiB.
			maxMessageSize: 1024 * 1024 * 1024,
		});
	}),
);

/** One round trip to the database. */
export const ping = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	yield* sql`select 1`;
});

/**
 * `ping`, answered within `limit`, for /health. Interrupting a query waits for the
 * client to cancel it on the server, which takes seconds on a hung connection. So the
 * ping runs in a fiber of its own, the answer waits only for `limit`, and a ping still
 * running then is stopped in the background.
 */
export const pingWithin = Effect.fn("Database.pingWithin")(function* (limit: Duration.Input) {
	const fiber = yield* Effect.forkDetach(ping);
	return yield* Fiber.join(fiber).pipe(
		Effect.timeout(limit),
		Effect.onError(() => Effect.forkDetach(Fiber.interrupt(fiber))),
	);
});

/**
 * The Postgres code of a failed query, such as "42P01" (no such table): postgres.js had it
 * on the error, the Effect client has it on the reason's cause (docs/effect.md, "Database").
 */
export function pgCode(error: SqlError): string | undefined {
	const cause = error.reason.cause;
	return Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) ? cause.code : undefined;
}

/**
 * A failed query's message as Postgres or the socket gave it, for a log line. The
 * error's own message is the client's ("PgConnection: Query failed"); postgres.js printed Postgres's.
 */
export function sqlMessage(error: SqlError): string {
	const cause = error.reason.cause;
	return Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message) ? cause.message : error.message;
}
