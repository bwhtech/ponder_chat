import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

/**
 * The indexing log of a document (docs/workspaces-plan.md, "Indexing log"): one row for
 * each step, with numbers, page numbers, model names and error messages, never a page's or
 * a passage's text. Rows are only added. A row's id names its document, its indexing run
 * (generation) and its step, so a step that Workflow runs again writes no second row.
 *
 * The cost of a row is read from its `runs` row when the log is read, so the two never
 * disagree, also after the sweep fills in a cost that came late.
 */
export type LogStep = "uploaded" | "reindexed" | "parsed" | "page-read" | "chunked" | "embedded" | "ready" | "failed";

/** Numbers and short labels only: never document text. */
export type LogDetail = Record<string, string | number | boolean | null>;

export type LogRow = {
	documentId: string;
	workspaceId: string;
	generation: number;
	step: LogStep;
	/** A page number or a batch number, for the steps that have one row each. */
	part?: number;
	detail: LogDetail;
	runId?: string | null;
};

/** One step as the Details view and the admin page read it. */
export type LogEntry = {
	generation: number;
	step: LogStep;
	at: string;
	detail: LogDetail;
	/** From `runs`. For `ready` and `failed`, the run's total; null when no model call cost anything (yet). */
	costUsd: number | null;
};

const EntryRow = Schema.Struct({
	generation: Schema.Number,
	step: Schema.Literals(["uploaded", "reindexed", "parsed", "page-read", "chunked", "embedded", "ready", "failed"]),
	detail: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])),
	created_at: Schema.Date,
	cost_usd: Schema.NullOr(Schema.Number),
});

export type IndexLog = {
	readonly write: (row: LogRow) => Effect.Effect<void, SqlError>;
	readonly read: (documentId: string) => Effect.Effect<LogEntry[], SqlError>;
	/** Milliseconds since the run's first row (`uploaded` or `reindexed`), so the total counts the wait in the queue too. */
	readonly elapsedMs: (documentId: string, generation: number) => Effect.Effect<number, SqlError>;
};

const ElapsedRow = Schema.Struct({ ms: Schema.Number });

export function indexLog(sql: PgClient.PgClient): IndexLog {
	const write = (row: LogRow) => sql`
		insert into workspace_document_log (id, document_id, workspace_id, generation, step, detail, run_id)
		values (${logId(row)}, ${row.documentId}, ${row.workspaceId}, ${row.generation}, ${row.step}, ${sql.json(row.detail)}, ${row.runId ?? null})
		on conflict (id) do nothing`.pipe(Effect.asVoid);

	// In the order the rows were written: created_at is clock_timestamp(), not the
	// transaction's start, so rows written in one transaction keep their order too.
	const findEntries = SqlSchema.findAll({
		Request: Schema.String,
		Result: EntryRow,
		execute: (documentId) => sql`
			select l.generation, l.step, l.detail, l.created_at, r.cost_usd::float8 as cost_usd
			from workspace_document_log l left join runs r on r.id = l.run_id
			where l.document_id = ${documentId}
			order by l.created_at, l.id`,
	});

	const read = (documentId: string) =>
		findEntries(documentId).pipe(
			Effect.catchTags({ SchemaError: Effect.die }),
			Effect.map((rows) => withTotals(rows.map((row): LogEntry => ({ generation: row.generation, step: row.step, at: row.created_at.toISOString(), detail: { ...row.detail }, costUsd: row.cost_usd })))),
		);

	const findElapsed = SqlSchema.findAll({
		Request: Schema.Struct({ documentId: Schema.String, generation: Schema.Number }),
		Result: ElapsedRow,
		execute: ({ documentId, generation }) => sql`
			select coalesce(round(extract(epoch from clock_timestamp() - min(created_at)) * 1000), 0)::float8 as ms
			from workspace_document_log where document_id = ${documentId} and generation = ${generation}`,
	});
	const elapsedMs = (documentId: string, generation: number) =>
		findElapsed({ documentId, generation }).pipe(
			Effect.catchTags({ SchemaError: Effect.die }),
			Effect.map(([row]) => row.ms),
		);

	return { write, read, elapsedMs };
}

function logId({ documentId, generation, step, part }: LogRow) {
	return [documentId, generation, step, ...(part === undefined ? [] : [part])].join(":");
}

/** A run's last row (`ready` or `failed`) shows what all its model calls cost. */
function withTotals(entries: LogEntry[]): LogEntry[] {
	return entries.map((entry) => {
		if (entry.step !== "ready" && entry.step !== "failed") return entry;
		const costs = entries.filter((other) => other.generation === entry.generation && other.costUsd !== null).map((other) => other.costUsd!);
		return { ...entry, costUsd: costs.length ? round(costs.reduce((sum, cost) => sum + cost, 0)) : null };
	});
}

function round(usd: number) {
	return Math.round(usd * 1e6) / 1e6;
}
