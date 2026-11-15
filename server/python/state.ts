import { gunzipSync, gzipSync } from "node:zlib";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { SavedState, type PythonState as State } from "./pyodide.ts";

/**
 * What a chat's Python runs keep between them: the variables (a dill snapshot), the
 * modules they came from, and the files in /work. Kept gzipped in Postgres, one row per
 * thread, so a run is a plain function of its inputs and this row. That suits durable
 * runs: a step that runs again after a restart starts from the same state.
 */
const StateRow = Schema.Struct({ data: Schema.Uint8Array });
const StateOfThread = Schema.Struct({ threadId: Schema.String, owner: Schema.String });
const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(SavedState));

export class PythonState extends Context.Service<
	PythonState,
	{
		readonly migrate: Effect.Effect<void, SqlError>;
		/** The state the last run in the person's thread left, or none. */
		readonly load: (threadId: string, owner: string) => Effect.Effect<Option.Option<State>, SqlError>;
		/** Not for a thread that was deleted while its run went on. */
		readonly save: (threadId: string, owner: string, state: State) => Effect.Effect<void, SqlError>;
		readonly forget: (threadId: string, owner: string) => Effect.Effect<void, SqlError>;
	}
>()("ponder/python/PythonState") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists python_state (
				thread_id text primary key,
				owner text not null,
				data bytea not null,
				updated_at timestamptz not null default now()
			)`;
	});

	const findState = SqlSchema.findOneOption({
		Request: StateOfThread,
		Result: StateRow,
		execute: ({ threadId, owner }) => sql`select data from python_state where thread_id = ${threadId} and owner = ${owner}`,
	});

	// A row that does not decode was not written by save: a defect.
	const load = Effect.fn("PythonState.load")(function* (threadId: string, owner: string) {
		const row = yield* findState({ threadId, owner }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.map(row, (found) => decodeState(gunzipSync(found.data).toString("utf8")));
	});

	const save = Effect.fn("PythonState.save")(function* (threadId: string, owner: string, state: State) {
		const data = gzipSync(JSON.stringify(state));
		yield* sql`
			insert into python_state (thread_id, owner, data)
			select ${threadId}, ${owner}, ${data} where exists (select 1 from threads where id = ${threadId} and owner = ${owner})
			on conflict (thread_id) do update set data = excluded.data, updated_at = now()
			where python_state.owner = excluded.owner`;
	});

	const forget = Effect.fn("PythonState.forget")(function* (threadId: string, owner: string) {
		yield* sql`delete from python_state where thread_id = ${threadId} and owner = ${owner}`;
	});

	return PythonState.of({ migrate, load, save, forget });
});

export const layer = Layer.effect(PythonState, make);
