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
 * The cost of a row is read from `runs` when the log is read, so the two never disagree,
 * also after the sweep fills in a cost that came late. A row's cost is its run's and the
 * tries of that run that were billed too (`<run>:failed:<uuid>`, `<run>:try:<n>`). The last
 * row of an indexing run (`ready`, `failed`) shows every call of its generation, also the
 * tries of a batch that never got its `embedded` row.
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
	/** From `runs`. For `ready` and `failed`, the generation's total; null when no model call cost anything (yet). */
	costUsd: number | null;
};

const EntryRow = Schema.Struct({
	generation: Schema.Number,
	step: Schema.Literals(["uploaded", "reindexed", "parsed", "page-read", "chunked", "embedded", "ready", "failed"]),
	detail: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])),
	created_at: Schema.Date,
	run_id: Schema.NullOr(Schema.String),
});
const CostRow = Schema.Struct({ id: Schema.String, cost_usd: Schema.NullOr(Schema.Number) });

/**
 * The `runs` rows of a document's indexing: their ids are `<function>:<document>:<generation>:<part>[:...]`
 * (Indexer.ts). The expression index of tables.ts finds them, also after the document is deleted.
 */
export const DOCUMENT_RUNS = "r.function_id in ('workspace-index', 'workspace-pdf') and split_part(r.id, ':', 2)";

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
			select generation, step, detail, created_at, run_id from workspace_document_log
			where document_id = ${documentId}
			order by created_at, id`,
	});
	const findCosts = SqlSchema.findAll({
		Request: Schema.String,
		Result: CostRow,
		execute: (documentId) => sql`select r.id, r.cost_usd::float8 as cost_usd from runs r where ${sql.literal(DOCUMENT_RUNS)} = ${documentId}`,
	});

	const read = (documentId: string) =>
		Effect.all([findEntries(documentId), findCosts(documentId)]).pipe(
			Effect.catchTags({ SchemaError: Effect.die }),
			Effect.map(([rows, costs]) =>
				rows.map((row): LogEntry => {
					const entry = { generation: row.generation, step: row.step, at: row.created_at.toISOString(), detail: { ...row.detail } };
					if (row.step === "ready" || row.step === "failed") return { ...entry, costUsd: total(costs.filter((cost) => generationOf(cost.id) === row.generation)) };
					return { ...entry, costUsd: row.run_id ? total(costs.filter((cost) => cost.id === row.run_id || cost.id.startsWith(`${row.run_id}:`))) : null };
				}),
			),
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

/** The calls' cost added up; null when none has a cost (yet). */
function total(rows: ReadonlyArray<typeof CostRow.Type>) {
	const costs = rows.flatMap((row) => (row.cost_usd === null ? [] : [row.cost_usd]));
	return costs.length ? round(costs.reduce((sum, cost) => sum + cost, 0)) : null;
}

function generationOf(runId: string) {
	return Number(runId.split(":")[2]);
}

function round(usd: number) {
	return Math.round(usd * 1e6) / 1e6;
}
