import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { vectorLiteral } from "../../openrouter/embeddings.ts";
import type { Passage } from "./chunk.ts";

/**
 * The passages of workspace documents, and search over them: meaning (pgvector's cosine
 * distance) and words (full text with the 'simple' configuration, so any language
 * works), merged with reciprocal rank fusion, as memory does (memory/pgvector-index.ts).
 *
 * Search reads only one workspace, only documents that are ready, and only passages that
 * the current embedding model made: a vector of another model is in another space.
 *
 * The `embedding` and `search` columns are never read: the client has no codec for them
 * (docs/effect.md, "Database").
 */
/** Embedding calls take this many passages each, as Flow's do. */
export const BATCH_SIZE = 96;
/** Each list (meaning, words) gives this many candidates to the fusion. */
const CANDIDATES = 50;
/** Reciprocal rank fusion's constant: a rank r scores 1 / (K + r). */
const K = 60;
/** Rows in one insert: 7 parameters each, under Postgres's 65,535. */
const INSERT_ROWS = 500;

/** A passage that search found, with where it is. */
export type Excerpt = { documentId: string; document: string; ordinal: number; page: number | null; location: string; content: string };

export type SearchRequest = { workspaceId: string; documentIds: ReadonlyArray<string>; model: string; query: string; vector: ReadonlyArray<number>; limit: number };

const BatchRow = Schema.Struct({ id: Schema.String, location: Schema.String, content: Schema.String, done: Schema.Boolean });
const CountRow = Schema.Struct({ count: Schema.Number });
const ExcerptRow = Schema.Struct({
	document_id: Schema.String,
	document: Schema.String,
	ordinal: Schema.Number,
	page: Schema.NullOr(Schema.Number),
	location: Schema.String,
	content: Schema.String,
});
const OutdatedRow = Schema.Struct({ id: Schema.String, status: Schema.Literals(["ready", "reading"]), models: Schema.Array(Schema.String) });

export type PassageStore = {
	/** The document's passages in place of the ones before, with no embeddings yet. In one transaction. */
	readonly replace: (documentId: string, workspaceId: string, passages: ReadonlyArray<Passage>) => Effect.Effect<void, SqlError>;
	/** One batch's passages, by ordinal; `done` when the model already embedded it. */
	readonly batch: (documentId: string, batch: number, model: string) => Effect.Effect<ReadonlyArray<typeof BatchRow.Type>, SqlError>;
	readonly saveEmbeddings: (model: string, rows: ReadonlyArray<{ id: string; vector: ReadonlyArray<number> }>) => Effect.Effect<void, SqlError>;
	/** Passages the model has not embedded yet. */
	readonly missing: (documentId: string, model: string) => Effect.Effect<number, SqlError>;
	readonly count: (documentId: string) => Effect.Effect<number, SqlError>;
	readonly search: (request: SearchRequest) => Effect.Effect<Excerpt[], SqlError>;
	/** Ready or Reading documents with a passage that another model embedded, and those models. */
	readonly outdated: (model: string) => Effect.Effect<ReadonlyArray<typeof OutdatedRow.Type>, SqlError>;
};

export function passageStore(sql: PgClient.PgClient): PassageStore {
	const decoded = <A, E, R>(effect: Effect.Effect<A, E | Schema.SchemaError, R>) => effect.pipe(Effect.catchTags({ SchemaError: Effect.die }));

	const findBatch = SqlSchema.findAll({
		Request: Schema.Struct({ documentId: Schema.String, from: Schema.Number, to: Schema.Number, model: Schema.String }),
		Result: BatchRow,
		execute: ({ documentId, from, to, model }) => sql`
			select id, location, content, (embedding is not null and model = ${model}) as done
			from workspace_passages where document_id = ${documentId} and ordinal >= ${from} and ordinal < ${to}
			order by ordinal`,
	});
	const findMissing = SqlSchema.findAll({
		Request: Schema.Struct({ documentId: Schema.String, model: Schema.String }),
		Result: CountRow,
		execute: ({ documentId, model }) => sql`
			select count(*)::int as count from workspace_passages
			where document_id = ${documentId} and (embedding is null or model is distinct from ${model})`,
	});
	const findCount = SqlSchema.findAll({
		Request: Schema.String,
		Result: CountRow,
		execute: (documentId) => sql`select count(*)::int as count from workspace_passages where document_id = ${documentId}`,
	});
	const findOutdated = SqlSchema.findAll({
		Request: Schema.String,
		Result: OutdatedRow,
		execute: (model) => sql`
			select d.id, d.status, array_agg(distinct p.model) as models
			from workspace_documents d join workspace_passages p on p.document_id = d.id
			where p.model is distinct from ${model} and (d.status = 'ready' or (d.status = 'reading' and p.model is not null))
			group by d.id, d.status`,
	});
	const findBest = SqlSchema.findAll({
		Request: Schema.Struct({
			workspaceId: Schema.String,
			documentIds: Schema.Array(Schema.String),
			model: Schema.String,
			words: Schema.String,
			vector: Schema.String,
			limit: Schema.Number,
		}),
		Result: ExcerptRow,
		execute: ({ workspaceId, documentIds, model, words, vector, limit }) => sql`
			with scoped as (
				select p.id, p.embedding, p.search from workspace_passages p join workspace_documents d on d.id = p.document_id
				where p.workspace_id = ${workspaceId} and d.workspace_id = ${workspaceId} and d.status = 'ready'
					and p.document_id = any(${documentIds}) and p.model = ${model} and p.embedding is not null
			),
			by_meaning as (
				select id, row_number() over (order by embedding <=> ${vector}::vector) as rank
				from scoped order by embedding <=> ${vector}::vector limit ${CANDIDATES}
			),
			by_words as (
				select id, row_number() over (order by ts_rank(search, q) desc, id) as rank
				from scoped, to_tsquery('simple', ${words}) q
				where ${words} <> '' and search @@ q
				order by ts_rank(search, q) desc, id limit ${CANDIDATES}
			),
			fused as (
				select id, sum(score) as score from (
					select id, 1.0 / (${K} + rank) as score from by_meaning
					union all
					select id, 1.0 / (${K} + rank) from by_words
				) ranked group by id
			)
			select p.document_id, d.name as document, p.ordinal, p.page, p.location, p.content
			from fused f join workspace_passages p on p.id = f.id join workspace_documents d on d.id = p.document_id
			order by f.score desc, p.document_id, p.ordinal limit ${limit}`,
	});

	const replace = (documentId: string, workspaceId: string, passages: ReadonlyArray<Passage>) =>
		sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`delete from workspace_passages where document_id = ${documentId}`;
				const rows = passages.map((passage) => ({
					id: `${documentId}:${passage.ordinal}`,
					document_id: documentId,
					workspace_id: workspaceId,
					ordinal: passage.ordinal,
					page: passage.page,
					location: passage.location,
					content: passage.content,
				}));
				for (const part of Arr.chunksOf(rows, INSERT_ROWS)) yield* sql`insert into workspace_passages ${sql.insert(part)}`;
			}),
		);

	const saveEmbeddings = (model: string, rows: ReadonlyArray<{ id: string; vector: ReadonlyArray<number> }>) =>
		sql`
			update workspace_passages p set embedding = v.embedding::vector, model = ${model}
			from (select unnest(${rows.map((row) => row.id)}::text[]) as id, unnest(${rows.map((row) => vectorLiteral(row.vector))}::text[]) as embedding) v
			where p.id = v.id`.pipe(Effect.asVoid);

	const search = (request: SearchRequest) =>
		request.documentIds.length === 0
			? Effect.succeed([])
			: decoded(findBest({ ...request, documentIds: [...request.documentIds], words: keywordQuery(request.query), vector: vectorLiteral(request.vector) })).pipe(
					Effect.map((rows) => rows.map((row): Excerpt => ({ documentId: row.document_id, document: row.document, ordinal: row.ordinal, page: row.page, location: row.location, content: row.content }))),
				);

	return {
		replace,
		batch: (documentId, batch, model) => decoded(findBatch({ documentId, from: batch * BATCH_SIZE, to: (batch + 1) * BATCH_SIZE, model })),
		saveEmbeddings,
		missing: (documentId, model) => decoded(findMissing({ documentId, model })).pipe(Effect.map(([row]) => row.count)),
		count: (documentId) => decoded(findCount(documentId)).pipe(Effect.map(([row]) => row.count)),
		search,
		outdated: (model) => decoded(findOutdated(model)),
	};
}

/**
 * The words of a question as a full-text query that any of them can match ("dose | cefazolin").
 * plainto_tsquery would ask for all of them, and a whole question rarely matches one
 * passage. Short words and common English words are left out: the 'simple' configuration
 * keeps every word, and "the" would match every passage.
 */
export function keywordQuery(query: string) {
	const words = query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
	const kept = [...new Set(words.filter((word) => word.length > 2 && !STOP_WORDS.has(word)))];
	return kept.slice(0, 32).join(" | ");
}

const STOP_WORDS = new Set(
	"the and for are was were with what which when where who whom how why does did done has have had this that these those from into than then there their them they you your our its can could should would will shall may might must not but all any each per about also been being use used using given give".split(
		" ",
	),
);
