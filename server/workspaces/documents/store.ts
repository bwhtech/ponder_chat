import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as ObjectStore from "../../files/ObjectStore.ts";
import { sqlMessage } from "../../runtime/Database.ts";

/**
 * The rows of `workspace_documents`, and the bytes of each document: in the bucket when
 * one is set up (files/ObjectStore.ts), else in the row. Access is checked by the callers
 * (Documents.ts, Workspaces.ts); a document is always read with its workspace's id, so an
 * id from another workspace is never found.
 */
export type DocumentStatus = "reading" | "ready" | "failed";

/** A document as the workspace page lists it. */
export type DocumentSummary = {
	id: string;
	name: string;
	mediaType: string;
	size: number;
	status: DocumentStatus;
	/** Why it failed, for the person; null unless failed. */
	error: string | null;
	createdAt: string;
};

const StatusSchema = Schema.Literals(["reading", "ready", "failed"]);

const DocumentRow = Schema.Struct({
	id: Schema.String,
	workspace_id: Schema.String,
	name: Schema.String,
	media_type: Schema.String,
	size: Schema.Number,
	object_key: Schema.NullOr(Schema.String),
	status: StatusSchema,
	error: Schema.NullOr(Schema.String),
	generation: Schema.Number,
	added_by: Schema.String,
	created_at: Schema.Date,
	has_text: Schema.Boolean,
	/** The Workflow run of this generation; null until it started. */
	index_run_id: Schema.NullOr(Schema.String),
	/** When this generation began. */
	reading_since: Schema.Date,
});
export type DocumentRow = typeof DocumentRow.Type;

const BytesRow = Schema.Struct({ data: Schema.NullOr(Schema.Uint8Array) });
const TextRow = Schema.Struct({ text: Schema.NullOr(Schema.String) });
const GenerationRow = Schema.Struct({ generation: Schema.Number });
const SizeRow = Schema.Struct({ id: Schema.String, name: Schema.String, chars: Schema.Number });
const TextOfRow = Schema.Struct({ id: Schema.String, name: Schema.String, text: Schema.String });

const COLUMNS = "id, workspace_id, name, media_type, size, object_key, status, error, generation, added_by, created_at, text is not null as has_text, index_run_id, reading_since";

export type NewDocument = { id: string; workspaceId: string; name: string; mediaType: string; data: Uint8Array; addedBy: string };

export function documentStore(sql: PgClient.PgClient, objects: ObjectStore.ObjectStore["Service"]): DocumentStore {
	const decoded = <A, E, R>(effect: Effect.Effect<A, E | Schema.SchemaError, R>) => effect.pipe(Effect.catchTags({ SchemaError: Effect.die }));

	const findAll = SqlSchema.findAll({
		Request: Schema.String,
		Result: DocumentRow,
		execute: (workspaceId) => sql`select ${sql.literal(COLUMNS)} from workspace_documents where workspace_id = ${workspaceId} order by created_at, id`,
	});
	const findOne = SqlSchema.findOneOption({
		Request: Schema.Struct({ workspaceId: Schema.String, documentId: Schema.String }),
		Result: DocumentRow,
		execute: ({ workspaceId, documentId }) => sql`select ${sql.literal(COLUMNS)} from workspace_documents where id = ${documentId} and workspace_id = ${workspaceId}`,
	});
	const findById = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: DocumentRow,
		execute: (documentId) => sql`select ${sql.literal(COLUMNS)} from workspace_documents where id = ${documentId}`,
	});
	const findBytes = SqlSchema.findOneOption({ Request: Schema.String, Result: BytesRow, execute: (id) => sql`select data from workspace_documents where id = ${id}` });
	const findText = SqlSchema.findOneOption({ Request: Schema.String, Result: TextRow, execute: (id) => sql`select text from workspace_documents where id = ${id}` });
	// The rows go, and their keys wait in workspace_object_deletions, in one statement: so a
	// rollback keeps both, and a commit keeps the keys until their objects are deleted.
	const deleteWhere = (where: Statement.Fragment) => sql<{ object_key: string }>`
		with gone as (delete from workspace_documents where ${where} returning object_key)
		insert into workspace_object_deletions (object_key) select object_key from gone where object_key is not null
		on conflict (object_key) do nothing
		returning object_key`;
	const findLeftKeys = SqlSchema.findAll({
		Request: Schema.Number,
		Result: Schema.Struct({ object_key: Schema.String }),
		execute: (seconds) => sql`
			select object_key from workspace_object_deletions
			where added_at < now() - make_interval(secs => ${seconds}) order by added_at limit 100`,
	});
	const findSizes = SqlSchema.findAll({
		Request: Schema.String,
		Result: SizeRow,
		execute: (workspaceId) => sql`
			select id, name, length(text)::int as chars from workspace_documents
			where workspace_id = ${workspaceId} and status = 'ready' and text is not null order by created_at, id`,
	});
	const findTexts = SqlSchema.findAll({
		Request: Schema.Array(Schema.String),
		Result: TextOfRow,
		execute: (ids) => sql`select id, name, text from workspace_documents where id = any(${ids}) and text is not null order by created_at, id`,
	});
	const restartWhere = SqlSchema.findOneOption({
		Request: Schema.Struct({ documentId: Schema.String, from: Schema.Array(StatusSchema), generation: Schema.NullOr(Schema.Number) }),
		Result: GenerationRow,
		execute: ({ documentId, from, generation }) => sql`
			update workspace_documents
			set status = 'reading', error = null, generation = generation + 1, index_run_id = null, reading_since = now()
			where id = ${documentId} and status = any(${from}) and generation = coalesce(${generation}::int, generation)
			returning generation`,
	});
	// FOR NO KEY UPDATE: a restart and a delete wait for it, and the passages and log rows
	// that the holder inserts (whose keys point here) do not.
	const lockReading = SqlSchema.findOneOption({
		Request: Schema.Struct({ documentId: Schema.String, generation: Schema.Number }),
		Result: DocumentRow,
		execute: ({ documentId, generation }) => sql`
			select ${sql.literal(COLUMNS)} from workspace_documents
			where id = ${documentId} and generation = ${generation} and status = 'reading'
			for no key update`,
	});
	const findReadingSince = SqlSchema.findAll({
		Request: Schema.Number,
		Result: DocumentRow,
		execute: (seconds) => sql`
			select ${sql.literal(COLUMNS)} from workspace_documents
			where status = 'reading' and reading_since < now() - make_interval(secs => ${seconds}) order by reading_since`,
	});

	/**
	 * Deletes the objects of rows that are gone (committed), and then their keys. A failure is
	 * logged, never the key: the key stays, and the sweep tries again (removeLeftObjects).
	 */
	const removeObjects = (keys: ReadonlyArray<string>) =>
		Effect.forEach(
			keys,
			(key) =>
				objects.remove(key).pipe(
					Effect.andThen(sql`delete from workspace_object_deletions where object_key = ${key}`),
					Effect.catchTags({
						ObjectStoreError: (error) => Effect.logWarning("workspace documents: could not delete an object:", error.message),
						SqlError: (error) => Effect.logWarning("workspace documents: could not forget a deleted object:", sqlMessage(error)),
					}),
				),
			{ concurrency: 4, discard: true },
		);

	return {
		list: (workspaceId: string) => decoded(findAll(workspaceId)).pipe(Effect.map((rows) => rows.map(summaryOf))),
		find: (workspaceId: string, documentId: string) => decoded(findOne({ workspaceId, documentId })),
		byId: (documentId: string) => decoded(findById(documentId)),

		/** Stores the bytes, then the row. The caller adds the first log row in the same transaction. */
		create: Effect.fnUntraced(function* (document: NewDocument) {
			const key = objects.enabled ? `workspaces/${document.workspaceId}/${document.id}` : null;
			if (key) yield* objects.put(key, document.data, document.mediaType);
			yield* sql`
				insert into workspace_documents (id, workspace_id, name, media_type, size, object_key, data, added_by)
				values (${document.id}, ${document.workspaceId}, ${document.name}, ${document.mediaType}, ${document.data.length}, ${key},
					${key ? null : document.data}, ${document.addedBy})`;
		}),

		bytes: Effect.fnUntraced(function* (row: DocumentRow) {
			if (row.object_key) return yield* objects.get(row.object_key);
			const found = yield* decoded(findBytes(row.id));
			return Option.flatMap(found, (bytes) => Option.fromNullOr(bytes.data)).pipe(Option.map((data) => Buffer.from(data)));
		}),

		text: (documentId: string) => decoded(findText(documentId)).pipe(Effect.map((row) => Option.flatMap(row, (found) => Option.fromNullOr(found.text)))),
		saveText: (documentId: string, text: string) => sql`update workspace_documents set text = ${text} where id = ${documentId}`.pipe(Effect.asVoid),

		/** The ready documents with text, and their length, oldest first. */
		readySizes: (workspaceId: string) => decoded(findSizes(workspaceId)),
		texts: (ids: ReadonlyArray<string>) => (ids.length ? decoded(findTexts(ids)) : Effect.succeed([])),

		/**
		 * Starts a new indexing run: "Reading", and its generation. None when the status is not
		 * one of `from`, or, when `generation` is given, another run took over meanwhile.
		 */
		restart: (documentId: string, from: ReadonlyArray<DocumentStatus>, generation: number | null = null) =>
			decoded(restartWhere({ documentId, from, generation })).pipe(Effect.map(Option.map((row) => row.generation))),

		/**
		 * Locks the document's row until the transaction ends, while `generation` is its latest
		 * and it is Reading. None when a newer run took over, it is settled, or it is gone.
		 */
		lockReading: (documentId: string, generation: number) => decoded(lockReading({ documentId, generation })),

		/** The generation's Workflow run, once it started. */
		setRun: (documentId: string, generation: number, runId: string) =>
			sql`update workspace_documents set index_run_id = ${runId} where id = ${documentId} and generation = ${generation}`.pipe(Effect.asVoid),

		/** The documents Reading for longer than `seconds`, oldest first. */
		readingFor: (seconds: number) => decoded(findReadingSince(seconds)),

		/** The end of an indexing run, unless a newer run took over. */
		settle: (documentId: string, generation: number, status: Exclude<DocumentStatus, "reading">, error: string | null) =>
			sql`update workspace_documents set status = ${status}, error = ${error} where id = ${documentId} and generation = ${generation}`.pipe(Effect.asVoid),

		/** The row, then its object once the delete committed. Not inside another transaction. */
		remove: Effect.fnUntraced(function* (row: DocumentRow) {
			const keys = yield* deleteWhere(sql`id = ${row.id}`);
			yield* removeObjects(keys.map((key) => key.object_key));
		}),

		/**
		 * All of a workspace's documents, with their passages and logs, inside the caller's
		 * transaction. Gives the keys of their objects: the caller deletes them (removeObjects)
		 * after it commits, so a rollback never leaves rows whose files are gone.
		 */
		removeAll: (workspaceId: string) => Effect.map(deleteWhere(sql`workspace_id = ${workspaceId}`), (keys) => keys.map((key) => key.object_key)),

		removeObjects,

		/** For the sweep: the objects whose deletion a crash or a failure left, older than `seconds`. Gives how many keys it tried. */
		removeLeftObjects: (seconds: number) =>
			Effect.gen(function* () {
				const keys = (yield* decoded(findLeftKeys(seconds))).map((key) => key.object_key);
				yield* removeObjects(keys);
				return keys.length;
			}),
	};
}

export type DocumentStore = {
	readonly list: (workspaceId: string) => Effect.Effect<DocumentSummary[], SqlError>;
	readonly find: (workspaceId: string, documentId: string) => Effect.Effect<Option.Option<DocumentRow>, SqlError>;
	readonly byId: (documentId: string) => Effect.Effect<Option.Option<DocumentRow>, SqlError>;
	readonly create: (document: NewDocument) => Effect.Effect<void, SqlError | ObjectStore.ObjectStoreError>;
	readonly bytes: (row: DocumentRow) => Effect.Effect<Option.Option<Buffer>, SqlError | ObjectStore.ObjectStoreError>;
	readonly text: (documentId: string) => Effect.Effect<Option.Option<string>, SqlError>;
	readonly saveText: (documentId: string, text: string) => Effect.Effect<void, SqlError>;
	readonly readySizes: (workspaceId: string) => Effect.Effect<ReadonlyArray<typeof SizeRow.Type>, SqlError>;
	readonly texts: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<typeof TextOfRow.Type>, SqlError>;
	readonly restart: (documentId: string, from: ReadonlyArray<DocumentStatus>, generation?: number | null) => Effect.Effect<Option.Option<number>, SqlError>;
	readonly lockReading: (documentId: string, generation: number) => Effect.Effect<Option.Option<DocumentRow>, SqlError>;
	readonly setRun: (documentId: string, generation: number, runId: string) => Effect.Effect<void, SqlError>;
	readonly readingFor: (seconds: number) => Effect.Effect<ReadonlyArray<DocumentRow>, SqlError>;
	readonly settle: (documentId: string, generation: number, status: Exclude<DocumentStatus, "reading">, error: string | null) => Effect.Effect<void, SqlError>;
	readonly remove: (row: DocumentRow) => Effect.Effect<void, SqlError>;
	readonly removeAll: (workspaceId: string) => Effect.Effect<ReadonlyArray<string>, SqlError>;
	readonly removeObjects: (keys: ReadonlyArray<string>) => Effect.Effect<void>;
	readonly removeLeftObjects: (seconds: number) => Effect.Effect<number, SqlError>;
};

export function summaryOf(row: DocumentRow): DocumentSummary {
	return { id: row.id, name: row.name, mediaType: row.media_type, size: row.size, status: row.status, error: row.error, createdAt: row.created_at.toISOString() };
}
