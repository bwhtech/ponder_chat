import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { PageRead } from "./document.ts";
import type { PageReadResult } from "./page-reader.ts";

/**
 * The pages that a model read in an indexing run, kept as each one ends
 * (`workspace_page_reads`): a run that a crash or a failed save cut short reads the rest
 * of the PDF, and pays for no page twice. Only for the same generation: "Try again"
 * reads every page again. The rows go once the run saved its text or failed.
 */
export type PageReadStore = {
	/** The pages read so far in this run, by page number. */
	readonly done: (documentId: string, generation: number) => Effect.Effect<ReadonlyMap<number, PageReadResult>, SqlError>;
	/** Keeps one page's read. Nothing when the document was deleted meanwhile. */
	readonly save: (documentId: string, generation: number, result: PageReadResult) => Effect.Effect<void, SqlError>;
	/** The document's rows, once its run no longer needs them. */
	readonly clear: (documentId: string) => Effect.Effect<void, SqlError>;
};

const DoneRow = Schema.Struct({ page: Schema.Number, record: PageRead, text: Schema.NullOr(Schema.String) });

export function pageReadStore(sql: PgClient.PgClient): PageReadStore {
	const findDone = SqlSchema.findAll({
		Request: Schema.Struct({ documentId: Schema.String, generation: Schema.Number }),
		Result: DoneRow,
		execute: ({ documentId, generation }) => sql`select page, record, text from workspace_page_reads where document_id = ${documentId} and generation = ${generation}`,
	});

	return {
		done: (documentId, generation) =>
			findDone({ documentId, generation }).pipe(
				Effect.catchTags({ SchemaError: Effect.die }),
				Effect.map((rows) => new Map(rows.map((row) => [row.page, { record: row.record, text: Option.fromNullOr(row.text) }]))),
			),
		save: (documentId, generation, { record, text }) =>
			sql`
				insert into workspace_page_reads (document_id, generation, page, record, text)
				select ${documentId}, ${generation}, ${record.page}, ${sql.json(record)}, ${Option.getOrNull(text)}
				where exists (select 1 from workspace_documents where id = ${documentId})
				on conflict do nothing`.pipe(Effect.asVoid),
		clear: (documentId) => sql`delete from workspace_page_reads where document_id = ${documentId}`.pipe(Effect.asVoid),
	};
}
