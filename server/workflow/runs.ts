import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
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
 *
 * The workflow (chat.ts, steps.ts) imports the types below as types only: this module
 * runs in Node, from the steps and the routes.
 */
export type Continued = { messageId: string; baseParts: number };
export type ThreadRun = { threadId: string; runId: string; model: string; finished: boolean; cancelled: boolean; failed: boolean; continued: Continued | null };
export type RunEnd = { cancelled?: boolean; failed?: boolean; continued?: Continued | null };

const RunRow = Schema.Struct({
	thread_id: Schema.String,
	run_id: Schema.String,
	model: Schema.String,
	finished_at: Schema.NullOr(Schema.Date),
	cancelled: Schema.Boolean,
	failed: Schema.Boolean,
	message_id: Schema.NullOr(Schema.String),
	base_parts: Schema.NullOr(Schema.Number),
});

export class ThreadRuns extends Context.Service<
	ThreadRuns,
	{
		readonly migrate: Effect.Effect<void, SqlError>;
		/**
		 * Run ids are ULIDs, so they sort in the order the runs started. A row only moves to a
		 * newer run, so a run that finished before this was written is not opened again.
		 */
		readonly setActive: (threadId: string, runId: string, model: string, continued?: Continued | null) => Effect.Effect<void, SqlError>;
		/** The run writing the thread's reply now, if any. */
		readonly active: (threadId: string) => Effect.Effect<Option.Option<ThreadRun>, SqlError>;
		/** A thread's latest run, by the thread id or by the run id. */
		readonly latest: (id: string) => Effect.Effect<Option.Option<ThreadRun>, SqlError>;
		/** The runs that are not marked finished: running, or ended without saving (replies.ts, finishEndedRuns). */
		readonly unfinished: Effect.Effect<ThreadRun[], SqlError>;
		/**
		 * Marks the run finished. A run quick enough to finish before the route wrote its row
		 * writes the row itself, finished. An older run never replaces a newer one, and a
		 * deleted thread gets no row.
		 *
		 * The first time a run is marked finished, this also sends its reply's root span
		 * (server/tracing/reply-trace.ts): every way a reply ends comes through here.
		 */
		readonly finish: (threadId: string, runId: string, model: string, end?: RunEnd) => Effect.Effect<void, SqlError>;
		/**
		 * True when the thread's latest run is newer than `runId`, or is `runId` and was stopped.
		 * A run that is still starting may not have its row yet: an older run's row does not count.
		 */
		readonly superseded: (threadId: string, runId: string) => Effect.Effect<boolean, SqlError>;
		/** For a deleted thread. */
		readonly forget: (threadId: string) => Effect.Effect<void, SqlError>;
		/**
		 * Runs `work` after the thread's earlier work ends, so two requests (a double submit, two
		 * tabs) never stop and start its runs at once. In this process only: one server runs at a
		 * time (becomeTheOnlyWorker in startup.ts). A Postgres lock would hold a connection from
		 * the pool while `work` needs others, and enough waiting requests would empty the pool.
		 */
		readonly withLock: <A, E, R>(threadId: string, work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
	}
>()("ponder/workflow/ThreadRuns") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists thread_runs (
				thread_id text primary key,
				run_id text not null,
				model text not null,
				started_at timestamptz not null default now()
			)`;
		yield* sql`alter table thread_runs add column if not exists finished_at timestamptz`;
		yield* sql`alter table thread_runs add column if not exists cancelled boolean not null default false`;
		yield* sql`create index if not exists thread_runs_run_id on thread_runs (run_id)`;
		yield* sql`alter table thread_runs add column if not exists message_id text`;
		yield* sql`alter table thread_runs add column if not exists base_parts integer`;
		yield* sql`alter table thread_runs add column if not exists failed boolean not null default false`;
	});

	const setActive = Effect.fn("ThreadRuns.setActive")(function* (threadId: string, runId: string, model: string, continued: Continued | null = null) {
		yield* sql`
			insert into thread_runs (thread_id, run_id, model, message_id, base_parts)
			values (${threadId}, ${runId}, ${model}, ${continued?.messageId ?? null}, ${continued?.baseParts ?? null})
			on conflict (thread_id) do update set run_id = excluded.run_id, model = excluded.model,
				message_id = excluded.message_id, base_parts = excluded.base_parts,
				started_at = now(), finished_at = null, cancelled = false, failed = false
			where excluded.run_id collate "C" > thread_runs.run_id collate "C"`;
	});

	const findRun = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: RunRow,
		execute: (id) => (id.startsWith("wrun_") ? sql`select * from thread_runs where run_id = ${id}` : sql`select * from thread_runs where thread_id = ${id}`),
	});
	const findUnfinished = SqlSchema.findAll({
		Request: Schema.Void,
		Result: RunRow,
		execute: () => sql`select * from thread_runs where finished_at is null`,
	});

	const latest = Effect.fn("ThreadRuns.latest")(function* (id: string) {
		const row = yield* findRun(id).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.map(row, threadRun);
	});

	const active = (threadId: string) => Effect.map(latest(threadId), Option.filter((run) => !run.finished));

	const unfinished = findUnfinished(undefined).pipe(
		Effect.catchTags({ SchemaError: Effect.die }),
		Effect.map((rows) => rows.map(threadRun)),
		Effect.withSpan("ThreadRuns.unfinished"),
	);

	const finish = Effect.fn("ThreadRuns.finish")(function* (threadId: string, runId: string, model: string, { cancelled = false, failed = false, continued = null }: RunEnd = {}) {
		// `returning` tells whether this marked the row: postgres.js gave the count.
		const marked = yield* sql`
			insert into thread_runs (thread_id, run_id, model, message_id, base_parts, finished_at, cancelled, failed)
			select ${threadId}, ${runId}, ${model}, ${continued?.messageId ?? null}, ${continued?.baseParts ?? null}, now(), ${cancelled}, ${failed}
			where exists (select 1 from threads where id = ${threadId})
			on conflict (thread_id) do update set run_id = excluded.run_id, model = excluded.model,
				message_id = excluded.message_id, base_parts = excluded.base_parts,
				finished_at = now(), cancelled = excluded.cancelled, failed = excluded.failed
			where (thread_runs.run_id = excluded.run_id and thread_runs.finished_at is null)
				or excluded.run_id collate "C" > thread_runs.run_id collate "C"
			returning thread_id`;
		if (marked.length) endReplyTrace({ runId, threadId, model, outcome: cancelled ? "cancelled" : failed ? "failed" : "saved", continued: Boolean(continued) });
	});

	const superseded = Effect.fn("ThreadRuns.superseded")(function* (threadId: string, runId: string) {
		const run = yield* latest(threadId);
		if (Option.isNone(run)) return false;
		return run.value.runId > runId || (run.value.runId === runId && run.value.cancelled);
	});

	const forget = Effect.fn("ThreadRuns.forget")(function* (threadId: string) {
		yield* sql`delete from thread_runs where thread_id = ${threadId}`;
	});

	// One lock per thread with work waiting or running, gone when the last one is done. A
	// Semaphore serves its waiters in order, as the old chain of promises did.
	const locks = new Map<string, { lock: Semaphore.Semaphore; holders: number }>();
	const withLock = <A, E, R>(threadId: string, work: Effect.Effect<A, E, R>) =>
		Effect.acquireUseRelease(
			Effect.sync(() => {
				const entry = locks.get(threadId) ?? { lock: Semaphore.makeUnsafe(1), holders: 0 };
				entry.holders++;
				locks.set(threadId, entry);
				return entry;
			}),
			(entry) => entry.lock.withPermit(work),
			(entry) =>
				Effect.sync(() => {
					if (--entry.holders === 0) locks.delete(threadId);
				}),
		);

	return ThreadRuns.of({ migrate, setActive, active, latest, unfinished, finish, superseded, forget, withLock });
});

export const layer = Layer.effect(ThreadRuns, make);

function threadRun(row: typeof RunRow.Type): ThreadRun {
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
