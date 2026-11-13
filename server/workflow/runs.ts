import { sql } from "../db.ts";
import { endReplyTrace } from "../tracing/reply-trace.ts";

/**
 * Each thread's latest workflow run: the one writing its reply now, or the last one.
 * A reloaded page follows the running one; Stop cancels it. When the reply is saved the
 * row is marked finished, not deleted, so a page that reconnects a moment late can still
 * replay the run. A cancelled run never closes its stream, so it is replayed only up to
 * what it had written. A failed run (the model kept erroring) is marked, so a page
 * that loads the thread later still offers Retry.
 *
 * A run that carries on the thread's last assistant message (after the person answered
 * an approval) keeps that message's id, and how many parts it had before the run.
 */
export type Continued = { messageId: string; baseParts: number };
export type ThreadRun = { threadId: string; runId: string; model: string; finished: boolean; cancelled: boolean; failed: boolean; continued: Continued | null };

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
	await sql`alter table thread_runs add column if not exists message_id text`;
	await sql`alter table thread_runs add column if not exists base_parts integer`;
	await sql`alter table thread_runs add column if not exists failed boolean not null default false`;
}

/**
 * Run ids are ULIDs, so they sort in the order the runs started. A row only moves to a
 * newer run, so a run that finished before this was written is not opened again.
 */
export async function setActiveRun(threadId: string, runId: string, model: string, continued: Continued | null = null) {
	await sql`
		insert into thread_runs (thread_id, run_id, model, message_id, base_parts)
		values (${threadId}, ${runId}, ${model}, ${continued?.messageId ?? null}, ${continued?.baseParts ?? null})
		on conflict (thread_id) do update set run_id = excluded.run_id, model = excluded.model,
			message_id = excluded.message_id, base_parts = excluded.base_parts,
			started_at = now(), finished_at = null, cancelled = false, failed = false
		where excluded.run_id collate "C" > thread_runs.run_id collate "C"`;
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
	return row && threadRun(row);
}

/** The runs that are not marked finished: running, or ended without saving (replies.ts, finishEndedRuns). */
export async function unfinishedRuns(): Promise<ThreadRun[]> {
	return (await sql`select * from thread_runs where finished_at is null`).map(threadRun);
}

function threadRun(row: Record<string, any>): ThreadRun {
	return {
		threadId: row.thread_id,
		runId: row.run_id,
		model: row.model,
		finished: Boolean(row.finished_at),
		cancelled: row.cancelled,
		failed: row.failed,
		continued: row.message_id ? { messageId: row.message_id, baseParts: row.base_parts ?? 0 } : null,
	};
}

/**
 * Marks the run finished. A run quick enough to finish before the route wrote its row
 * writes the row itself, finished. An older run never replaces a newer one, and a
 * deleted thread gets no row.
 *
 * The first time a run is marked finished, this also sends its reply's root span
 * (server/tracing/reply-trace.ts): every way a reply ends comes through here.
 */
export async function finishRun(
	threadId: string,
	runId: string,
	model: string,
	{ cancelled = false, failed = false, continued = null as Continued | null } = {},
) {
	const marked = await sql`
		insert into thread_runs (thread_id, run_id, model, message_id, base_parts, finished_at, cancelled, failed)
		select ${threadId}, ${runId}, ${model}, ${continued?.messageId ?? null}, ${continued?.baseParts ?? null}, now(), ${cancelled}, ${failed}
		where exists (select 1 from threads where id = ${threadId})
		on conflict (thread_id) do update set run_id = excluded.run_id, model = excluded.model,
			message_id = excluded.message_id, base_parts = excluded.base_parts,
			finished_at = now(), cancelled = excluded.cancelled, failed = excluded.failed
		where (thread_runs.run_id = excluded.run_id and thread_runs.finished_at is null)
			or excluded.run_id collate "C" > thread_runs.run_id collate "C"`;
	if (marked.count) endReplyTrace({ runId, threadId, model, outcome: cancelled ? "cancelled" : failed ? "failed" : "saved", continued: Boolean(continued) });
}

/**
 * True when the thread's latest run is newer than `runId`, or is `runId` and was stopped.
 * A run that is still starting may not have its row yet: an older run's row does not count.
 */
export async function superseded(threadId: string, runId: string) {
	const run = await latestRun(threadId);
	if (!run) return false;
	return run.runId > runId || (run.runId === runId && run.cancelled);
}

/** For a deleted thread. */
export async function forgetRuns(threadId: string) {
	await sql`delete from thread_runs where thread_id = ${threadId}`;
}

const locks = new Map<string, Promise<unknown>>();

/**
 * Runs `work` after the thread's earlier work ends, so two requests (a double submit, two
 * tabs) never stop and start its runs at once. In this process only: one server runs at a
 * time (becomeTheOnlyWorker in startup.ts). A Postgres lock would hold a connection from
 * the pool while `work` needs others, and enough waiting requests would empty the pool.
 */
export async function withThreadLock<T>(threadId: string, work: () => Promise<T>): Promise<T> {
	const before = locks.get(threadId) ?? Promise.resolve();
	const done = before.catch(() => undefined).then(work);
	const tail = done.catch(() => undefined);
	locks.set(threadId, tail);
	try {
		return await done;
	} finally {
		if (locks.get(threadId) === tail) locks.delete(threadId);
	}
}
