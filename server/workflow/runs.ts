import { sql } from "../db.ts";

/**
 * Each thread's latest workflow run: the one writing its reply now, or the last one.
 * A reloaded page follows the running one; Stop cancels it. When the reply is saved the
 * row is marked finished, not deleted, so a page that reconnects a moment late can still
 * replay the run. A cancelled run never closes its stream, so it is replayed only up to
 * what it had written.
 */
export type ThreadRun = { threadId: string; runId: string; model: string; finished: boolean; cancelled: boolean };

export async function migrateThreadRuns() {
	await sql`
		create table if not exists thread_runs (
			thread_id text primary key,
			run_id text not null,
			model text not null,
			started_at timestamptz not null default now()
		)`;
	await sql`alter table thread_runs add column if not exists finished_at timestamptz`;
	await sql`alter table thread_runs add column if not exists cancelled boolean not null default false`;
	await sql`create index if not exists thread_runs_run_id on thread_runs (run_id)`;
}

export async function setActiveRun(threadId: string, runId: string, model: string) {
	await sql`
		insert into thread_runs (thread_id, run_id, model) values (${threadId}, ${runId}, ${model})
		on conflict (thread_id) do update set run_id = excluded.run_id, model = excluded.model,
			started_at = now(), finished_at = null, cancelled = false`;
}

/** The run writing the thread's reply now, if any. */
export async function activeRun(threadId: string): Promise<ThreadRun | undefined> {
	const run = await latestRun(threadId);
	return run && !run.finished ? run : undefined;
}

/** A thread's latest run, by the thread id or by the run id. */
export async function latestRun(id: string): Promise<ThreadRun | undefined> {
	const [row] = id.startsWith("wrun_")
		? await sql`select * from thread_runs where run_id = ${id}`
		: await sql`select * from thread_runs where thread_id = ${id}`;
	return row && { threadId: row.thread_id, runId: row.run_id, model: row.model, finished: Boolean(row.finished_at), cancelled: row.cancelled };
}

export async function finishRun(threadId: string, runId: string, { cancelled = false } = {}) {
	await sql`
		update thread_runs set finished_at = now(), cancelled = ${cancelled}
		where thread_id = ${threadId} and run_id = ${runId} and finished_at is null`;
}
