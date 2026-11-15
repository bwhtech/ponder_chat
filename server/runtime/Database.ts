import * as PgClient from "@effect/sql-pg/PgClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
		});
	}),
);

/** One round trip to the database, for /health. */
export const ping = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	yield* sql`select 1`;
});
