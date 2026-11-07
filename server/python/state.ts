import { gunzipSync, gzipSync } from "node:zlib";
import { sql } from "../db.ts";
import type { PythonState } from "./pyodide.ts";

/**
 * What a chat's Python runs keep between them: the variables (a dill snapshot), the
 * modules they came from, and the files in /work. Kept gzipped in Postgres, one row per
 * thread, so a run is a plain function of its inputs and this row. That suits durable
 * runs: a step that runs again after a restart starts from the same state.
 */
export async function migratePythonState() {
	await sql`
		create table if not exists python_state (
			thread_id text primary key,
			owner text not null,
			data bytea not null,
			updated_at timestamptz not null default now()
		)`;
}

export async function loadPythonState(threadId: string, owner: string): Promise<PythonState | undefined> {
	const [row] = await sql<{ data: Buffer }[]>`select data from python_state where thread_id = ${threadId} and owner = ${owner}`;
	return row ? (JSON.parse(gunzipSync(row.data).toString("utf8")) as PythonState) : undefined;
}

/** Not for a thread that was deleted while its run went on. */
export async function savePythonState(threadId: string, owner: string, state: PythonState) {
	const data = gzipSync(JSON.stringify(state));
	await sql`
		insert into python_state (thread_id, owner, data)
		select ${threadId}, ${owner}, ${data} where exists (select 1 from threads where id = ${threadId} and owner = ${owner})
		on conflict (thread_id) do update set data = excluded.data, updated_at = now()
		where python_state.owner = excluded.owner`;
}

export async function forgetPythonState(threadId: string, owner: string) {
	await sql`delete from python_state where thread_id = ${threadId} and owner = ${owner}`;
}
