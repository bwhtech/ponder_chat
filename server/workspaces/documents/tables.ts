import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";

/**
 * The tables of workspace documents (docs/workspaces-plan.md, "Database"). Workspaces.migrate
 * runs this after its own tables, so it is safe to run again on a database that has them.
 * After `runs` (Telemetry.setup): a log row references the model call it records.
 *
 * - `workspace_documents`: one row for each file. The bytes are in the bucket under
 *   `workspaces/<workspace>/<document>`, or in `data` when no bucket is set up. `text` is
 *   the Markdown that was read, null until then; a PDF's pages start with "--- Page N ---".
 *   `generation` counts the indexing runs, so the ids of a run's log and `runs` rows never
 *   meet those of an earlier run. `index_run_id` is the Workflow run of the latest
 *   generation, null until it started; `reading_since` is when that generation began. The
 *   sweep reads both to start again a run that never started or ended without settling.
 *   `page_count` and `model_pages` are a PDF's pages and how many of them a model reads,
 *   kept once the PDF is parsed, so the document's row can show its progress (store.ts,
 *   progressOf). They are null until then, and again when a new run starts.
 * - `workspace_document_log`: what each indexing run did, as numbers only. Rows are only
 *   added, and go with their document.
 * - `workspace_page_reads`: the pages a model read in an indexing run, kept as each ends,
 *   so a run that starts again pays for none twice (page-reads.ts). Gone once the run saved
 *   its text or failed.
 * - `workspace_object_deletions`: the bucket keys of deleted documents, written in the
 *   transaction that deletes their rows. The objects are deleted after it commits, and a
 *   key stays here until its object is gone, so the sweep deletes what a crash left.
 * - `workspace_passages`: the passages that search returns. `embedding` has no width, so
 *   any embedding model fits; `model` names the one that made it, and search reads only
 *   the current model's. `search` is the keyword index of the location line and the text.
 */
export const migrateDocuments = (sql: PgClient.PgClient) =>
	Effect.gen(function* () {
		// In public, whatever the search path: an extension is one per database, so one made in a test's own
		// schema hid its type from every other schema, and went when that schema was dropped.
		yield* sql`create extension if not exists vector schema public`;
		yield* sql`
			create table if not exists workspace_documents (
				id text primary key,
				workspace_id text not null references workspaces (id) on delete cascade,
				name text not null,
				media_type text not null,
				size integer not null,
				object_key text,
				data bytea,
				text text,
				status text not null default 'reading' check (status in ('reading', 'ready', 'failed')),
				error text,
				generation integer not null default 1,
				added_by text not null,
				created_at timestamptz not null default now()
			)`;
		// For a database made before they came.
		yield* sql`alter table workspace_documents add column if not exists index_run_id text`;
		yield* sql`alter table workspace_documents add column if not exists reading_since timestamptz not null default now()`;
		yield* sql`alter table workspace_documents add column if not exists page_count integer`;
		yield* sql`alter table workspace_documents add column if not exists model_pages integer`;
		yield* sql`create index if not exists workspace_documents_workspace on workspace_documents (workspace_id, created_at)`;
		yield* sql`create index if not exists workspace_documents_reading on workspace_documents (reading_since) where status = 'reading'`;
		yield* sql`
			create table if not exists workspace_document_log (
				id text primary key,
				document_id text not null references workspace_documents (id) on delete cascade,
				workspace_id text not null,
				generation integer not null,
				step text not null,
				detail jsonb not null default '{}',
				run_id text references runs (id),
				created_at timestamptz not null default clock_timestamp()
			)`;
		yield* sql`create index if not exists workspace_document_log_document on workspace_document_log (document_id, created_at)`;
		yield* sql`
			create table if not exists workspace_passages (
				id text primary key,
				document_id text not null references workspace_documents (id) on delete cascade,
				workspace_id text not null,
				ordinal integer not null,
				page integer,
				location text not null,
				content text not null,
				embedding vector,
				model text,
				search tsvector generated always as (to_tsvector('simple', location || ' ' || content)) stored
			)`;
		yield* sql`create index if not exists workspace_passages_document on workspace_passages (document_id, ordinal)`;
		yield* sql`create index if not exists workspace_passages_workspace on workspace_passages (workspace_id, model)`;
		yield* sql`create index if not exists workspace_passages_search on workspace_passages using gin (search)`;
		yield* sql`
			create table if not exists workspace_page_reads (
				document_id text not null references workspace_documents (id) on delete cascade,
				generation integer not null,
				page integer not null,
				record jsonb not null,
				text text,
				primary key (document_id, generation, page)
			)`;
		// A document's model calls in `runs`, by the document id in their run id (log.ts, DOCUMENT_RUNS).
		yield* sql`
			create index if not exists runs_workspace_document on runs (split_part(id, ':', 2))
			where function_id in ('workspace-index', 'workspace-pdf')`;
		yield* sql`
			create table if not exists workspace_object_deletions (
				object_key text primary key,
				added_at timestamptz not null default now()
			)`;
	});
