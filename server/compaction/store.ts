import type { UIMessage } from "ai";
import { sql } from "../db.ts";
import { fingerprint, isCurrent } from "./fingerprint.ts";
import type { Summary } from "./summary.ts";
import { DEFAULT_RATIO } from "./tokens.ts";

/**
 * What compaction keeps for each thread: its summary, and how many tokens the provider
 * counts for each token Ponder estimates (tokens.ts). Both go with the thread.
 */
export async function migrateCompaction() {
	await sql`
		create table if not exists thread_summaries (
			thread_id text primary key references threads (id) on delete cascade,
			summary text not null,
			covers integer not null,
			fingerprint text not null,
			keep_files boolean not null default true,
			reads integer,
			model text not null,
			created_at timestamptz not null default now()
		)`;
	await sql`alter table thread_summaries add column if not exists reads integer`;
	await sql`
		create table if not exists thread_token_ratios (
			thread_id text primary key references threads (id) on delete cascade,
			model text not null,
			ratio real not null,
			updated_at timestamptz not null default now()
		)`;
}

/** The thread's summary, if the messages the summarizer read are still the same. */
export async function loadSummary(threadId: string, thread: UIMessage[]): Promise<Summary | undefined> {
	const [row] = await sql<{ summary: string; covers: number; reads: number | null; fingerprint: string; keep_files: boolean }[]>`
		select summary, covers, reads, fingerprint, keep_files from thread_summaries where thread_id = ${threadId}`;
	const reads = row?.reads ?? row?.covers ?? 0;
	if (!row || !isCurrent(thread, { reads, fingerprint: row.fingerprint })) return undefined;
	return { text: row.summary, covers: row.covers, keepFiles: row.keep_files, reads };
}

/** Replaces the thread's summary. Nothing is saved for a thread deleted meanwhile. */
export async function saveSummary(threadId: string, thread: UIMessage[], summary: Summary, model: string) {
	const reads = summary.reads ?? summary.covers;
	await sql`
		insert into thread_summaries (thread_id, summary, covers, reads, fingerprint, keep_files, model)
		select ${threadId}, ${summary.text}, ${summary.covers}, ${reads}, ${fingerprint(thread.slice(0, reads))}, ${summary.keepFiles}, ${model}
		where exists (select 1 from threads where id = ${threadId})
		on conflict (thread_id) do update set summary = excluded.summary, covers = excluded.covers, reads = excluded.reads,
			fingerprint = excluded.fingerprint, keep_files = excluded.keep_files, model = excluded.model, created_at = now()`;
}

/** The thread's measured ratio for this model, or the default before a call of it was measured. */
export async function tokenRatio(threadId: string, model: string): Promise<number> {
	const [row] = await sql<{ ratio: number }[]>`select ratio from thread_token_ratios where thread_id = ${threadId} and model = ${model}`;
	return row?.ratio ?? DEFAULT_RATIO;
}

export async function saveTokenRatio(threadId: string, model: string, ratio: number) {
	await sql`
		insert into thread_token_ratios (thread_id, model, ratio)
		select ${threadId}, ${model}, ${ratio} where exists (select 1 from threads where id = ${threadId})
		on conflict (thread_id) do update set model = excluded.model, ratio = excluded.ratio, updated_at = now()`;
}
