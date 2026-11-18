import * as PgClient from "@effect/sql-pg/PgClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type { SqlError } from "effect/sql/SqlError";
import * as ObjectStore from "../../files/ObjectStore.ts";
import { makeEmbedder, type EmbeddingError } from "../../openrouter/embeddings.ts";
import * as Runs from "../../telemetry/Runs.ts";
import * as Tracing from "../../tracing/Tracing.ts";
import { embeddingText } from "./chunk.ts";
import { cutError, type DocumentText, type PageRead } from "./document.ts";
import { indexLog, type LogDetail, type LogRow } from "./log.ts";
import { pageReadStore } from "./page-reads.ts";
import * as PageReader from "./page-reader.ts";
import { BATCH_SIZE, passageStore } from "./passages.ts";
import * as PrepareText from "./prepare-text.ts";
import { PDF_TYPE } from "./read-document.ts";
import { readPdf, type PageCheckpoint } from "./read-pdf.ts";
import { documentStore, type DocumentRow } from "./store.ts";

/**
 * Indexes one document (docs/workspaces-plan.md, "Documents: what Ponder does"): read its
 * text once, split it into passages, embed them BATCH_SIZE at a time, and mark it Ready or
 * Failed. Reading a document and splitting its text run in a worker thread
 * (prepare-text.ts): a text document in one job; a PDF's pages in one, and its text and
 * passages in another once a model read its picture pages (read-pdf.ts).
 * The workflow (index-workflow.ts) runs each part as a step, so a run that a crash cut
 * short goes on from the batch it was in: a large text is about 125 embedding calls.
 *
 * Each part is safe to run again. The text is read only while the row has none; a batch
 * the current model embedded is skipped; log rows and `runs` rows have ids of their own.
 * A part of a run that a newer run replaced, or of a deleted document, does nothing.
 *
 * Who pays: the system (`workspace-index`, `workspace-pdf` in `runs`), in the uploader's
 * name. Logs and spans have ids and counts only: never a name or the text.
 */
export type IndexRequest = { documentId: string; generation: number };
/** One embedding call of a batch of 96 passages at most; then the step fails, and Workflow tries it again. */
const INDEX_TIMEOUT = "2 minutes";
/**
 * A document in preparation holds its bytes, its text and its passages in this process,
 * from loading them until its passages are saved. Each takes a permit for each MB of its
 * file (at least one), of PREPARING_MB in all: four of the largest uploads at once, or
 * many small ones. A document waits for its permits before it loads anything, so the
 * Workflow queue's runs that wait hold only their ids. A PDF keeps its permits while a
 * model reads its picture pages: its bytes are needed for each page.
 */
const PREPARING_MB = 40;
const MB = 1024 * 1024;
export type Prepared = { state: "gone" } | { state: "failed" } | { state: "chunked"; batches: number };
export type IndexStage = "parse" | "page-read" | "chunk" | "embed" | "finish";
export type IndexOutcome = "gone" | "ready" | "failed";

export class Indexer extends Context.Service<
	Indexer,
	{
		/** The embedding model that passages are made with now. */
		readonly model: string;
		/** Reads the text when the document has none yet, then splits it into passages, with no embeddings. */
		readonly prepare: (request: IndexRequest) => Effect.Effect<Prepared, SqlError | ObjectStore.ObjectStoreError>;
		/** Embeds one batch of passages, unless the current model did already. */
		readonly embedBatch: (request: IndexRequest, batch: number) => Effect.Effect<void, EmbeddingError>;
		/** Ready, when every passage has an embedding of the current model. */
		readonly finish: (request: IndexRequest) => Effect.Effect<IndexOutcome, SqlError>;
		/** Failed, with what the person reads. */
		readonly fail: (request: IndexRequest, stage: IndexStage, error: string) => Effect.Effect<void, SqlError>;
		/** All the parts in one go, for tests and scripts: the workflow runs them as steps. */
		readonly run: (request: IndexRequest) => Effect.Effect<IndexOutcome, SqlError>;
	}
>()("ponder/workspaces/Indexer") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const runs = yield* Runs.Runs;
	const store = documentStore(sql, yield* ObjectStore.ObjectStore);
	const log = indexLog(sql);
	const passages = passageStore(sql);
	const pageReads = pageReadStore(sql);
	const embedder = yield* makeEmbedder;
	const readers = yield* Effect.context<PageReader.PageReader | PrepareText.PrepareText>();
	const prepareText = yield* PrepareText.PrepareText;
	const preparing = yield* Semaphore.make(PREPARING_MB);

	/** The document, while this run is its latest. A first look: each write checks again (fenced). */
	const current = (request: IndexRequest) =>
		Effect.map(store.byId(request.documentId), Option.filter((row) => row.generation === request.generation));
	const logRow = (row: DocumentRow, step: LogRow["step"], detail: LogDetail, extra: Partial<LogRow> = {}) =>
		log.write({ documentId: row.id, workspaceId: row.workspace_id, generation: row.generation, step, detail, ...extra });

	/**
	 * Runs `write` in a transaction that holds the document's row, while this run is still its
	 * latest and the document is Reading. A step can wait minutes on a model: a newer run, "Try
	 * again" or a delete may come meanwhile. They wait for a write in progress, and a write
	 * after them does nothing. None when the run was overtaken, or the document is settled or gone.
	 */
	const fenced = <A, E, R>(row: Pick<DocumentRow, "id" | "generation">, write: (locked: DocumentRow) => Effect.Effect<A, E, R>) =>
		sql.withTransaction(
			Effect.gen(function* () {
				const locked = yield* store.lockReading(row.id, row.generation);
				if (Option.isNone(locked)) return Option.none<A>();
				return Option.some(yield* write(locked.value));
			}),
		);

	/** Failed, with the page reads that led to it. "gone" when a newer run took over. */
	const failRow = Effect.fnUntraced(function* (row: DocumentRow, stage: IndexStage, error: string, extra: LogDetail = {}, reads: ReadonlyArray<PageRead> = []) {
		const message = cutError(error);
		const failed = yield* fenced(row, (locked) =>
			Effect.gen(function* () {
				yield* logPageReads(locked, reads);
				yield* pageReads.clear(locked.id);
				const ms = yield* log.elapsedMs(locked.id, locked.generation);
				yield* store.settle(locked.id, locked.generation, "failed", message);
				yield* logRow(locked, "failed", { step: stage, error: message, ms, ...extra });
			}),
		);
		if (Option.isNone(failed)) return "gone" as const;
		yield* Effect.logWarning(`workspace documents: indexing failed for document ${row.id} of workspace ${row.workspace_id}`);
		return "failed" as const;
	});

	/**
	 * The text, and the page reads' log rows, together. A PDF's `parsed` row and most of its
	 * page reads were written as they happened (checkpointOf): a row that is there already is
	 * not written twice (log.ts), so these add only what is missing, such as a text
	 * document's `parsed` row, or a page that could not be copied out of the PDF.
	 */
	const saveRead = (row: DocumentRow, text: string, read: Omit<DocumentText, "pages">) =>
		fenced(row, (locked) =>
			Effect.gen(function* () {
				yield* store.saveText(locked.id, text);
				yield* pageReads.clear(locked.id);
				yield* logRow(locked, "parsed", { engine: read.engine, pages: read.pageCount, chars: read.chars, ms: read.ms });
				yield* logPageReads(locked, read.pageReads);
			}),
		);

	/**
	 * The pages this run read already, and how to keep each new one: its `runs` rows first, so
	 * its spend is kept also for a run that a newer one overtook, then the page and its log
	 * row, while this run is still the latest. The read stops once this run is no longer the
	 * document's latest (a delete, "Try again").
	 *
	 * Once the PDF is parsed, before any page goes to a model, its page count and how many
	 * pages a model reads are kept with its `parsed` log row: the document's progress counts
	 * them (store.ts, progressOf), and Details show the pages while they are read.
	 */
	const checkpointOf = Effect.fnUntraced(function* (row: DocumentRow) {
		return {
			parsed: (parsed) =>
				fenced(row, (locked) =>
					Effect.andThen(
						store.savePages(locked.id, parsed.pageCount, parsed.modelPages),
						logRow(locked, "parsed", { engine: parsed.engine, pages: parsed.pageCount, chars: parsed.chars, ms: parsed.ms }),
					),
				).pipe(Effect.asVoid),
			done: yield* pageReads.done(row.id, row.generation),
			save: (result) =>
				Effect.andThen(
					Effect.forEach(pageReadRuns(row, result.record), runs.insert, { discard: true }),
					fenced(row, (locked) => Effect.andThen(pageReads.save(locked.id, locked.generation, result), logPageReads(locked, [result.record]))).pipe(Effect.asVoid),
				),
			live: Effect.map(current({ documentId: row.id, generation: row.generation }), (found) => Option.isSome(found) && found.value.status === "reading"),
		} satisfies PageCheckpoint;
	});

	const logPageReads = Effect.fnUntraced(function* (row: DocumentRow, reads: ReadonlyArray<PageRead>) {
		for (const read of reads) {
			const { page, reason, model, ms, ok, error, attempts, inputTokens, outputTokens } = read;
			yield* logRow(row, "page-read", { page, reason, model, ms, ok, error, attempts, inputTokens, outputTokens }, { part: page, runId: pageRunId(row, read) });
		}
	});

	/**
	 * The document's passages: a document read now gives them with its text; else they are
	 * split from the stored text. Or how the run ended: failed, or gone when a newer run
	 * took over meanwhile.
	 */
	const passagesOf = Effect.fnUntraced(function* (row: DocumentRow) {
		if (!row.has_text) return yield* parse(row);
		const text = Option.getOrElse(yield* store.text(row.id), () => "");
		const passages = yield* prepareText.chunk({ name: row.name, mediaType: row.media_type, text }).pipe(Effect.result);
		return passages._tag === "Failure" ? yield* failPrepare(row, "chunk", passages.failure) : passages.success;
	});

	/** The passages of a document read now, or how the run ended: failed, or gone when a newer run took over meanwhile. */
	const parse = Effect.fn("workspace.parse")(function* (row: DocumentRow) {
		yield* Tracing.annotate({ "ponder.bytes": row.size });
		const bytes = yield* store.bytes(row);
		if (Option.isNone(bytes)) return yield* failRow(row, "parse", "The file is missing from storage. Upload it again.");
		const data = new Uint8Array(bytes.value.buffer, bytes.value.byteOffset, bytes.value.byteLength);
		return row.media_type === PDF_TYPE ? yield* parsePdf(row, data) : yield* parseText(row, data);
	});

	const parsePdf = Effect.fnUntraced(function* (row: DocumentRow, data: Uint8Array) {
		const checkpoint = yield* checkpointOf(row);
		const read = yield* readPdf(data, checkpoint).pipe(Effect.provideContext(readers), Effect.result);
		if (read._tag === "Failure") {
			const error = read.failure;
			if (error._tag === "SqlError") return yield* error;
			if (error._tag === "ReadStopped") return "gone" as const;
			if (error._tag === "PageUnreadable") return yield* failRow(row, "page-read", error.message, { page: error.page }, error.pageReads);
			return yield* failPrepare(row, "parse", error);
		}
		const { pages, ...summary } = read.success;
		if (summary.chars === 0) return yield* failRow(row, "parse", "The document has no text.");
		const prepared = yield* prepareText.preparePdf({ name: row.name, pages }).pipe(Effect.result);
		if (prepared._tag === "Failure") return yield* failPrepare(row, "chunk", prepared.failure);
		return yield* saved(row, prepared.success, summary);
	});

	const parseText = Effect.fnUntraced(function* (row: DocumentRow, data: Uint8Array) {
		const read = yield* prepareText.read({ name: row.name, mediaType: row.media_type, data }).pipe(Effect.result);
		if (read._tag === "Failure") return yield* failPrepare(row, "parse", read.failure);
		return yield* saved(row, read.success, read.success.read);
	});

	/** The passages once the text is kept; failed when there is none, gone when a newer run took over. */
	const saved = Effect.fnUntraced(function* (row: DocumentRow, prepared: PrepareText.PreparedText, read: Omit<DocumentText, "pages">) {
		if (read.chars === 0) return yield* failRow(row, "parse", "The document has no text.");
		return Option.isSome(yield* saveRead(row, prepared.text, read)) ? prepared.passages : ("gone" as const);
	});

	/** Failed, with what the person reads, and the worker's reason when the worker failed. */
	const failPrepare = (row: DocumentRow, stage: IndexStage, error: PrepareText.PrepareError) =>
		failRow(row, stage, error.message, error._tag === "PrepareTextError" ? { reason: error.reason } : {});

	const prepare = Effect.fn("Indexer.prepare")(function* (request: IndexRequest) {
		const found = yield* current(request);
		if (Option.isNone(found)) return { state: "gone" } satisfies Prepared;
		const permits = Math.min(PREPARING_MB, Math.max(1, Math.ceil(found.value.size / MB)));
		const waiting = yield* Clock.currentTimeMillis;
		return yield* preparing.withPermits(permits)(
			Effect.gen(function* () {
				yield* Tracing.annotate({ "ponder.wait_ms": (yield* Clock.currentTimeMillis) - waiting });
				return yield* prepareAdmitted(request);
			}),
		);
	});

	/** With its permits: a run that waited for them may have been overtaken meanwhile, so the row is read again. */
	const prepareAdmitted = Effect.fnUntraced(function* (request: IndexRequest) {
		const found = yield* current(request);
		if (Option.isNone(found)) return { state: "gone" } satisfies Prepared;
		const row = found.value;
		yield* Effect.log(`workspace documents: indexing document ${row.id} of workspace ${row.workspace_id}`);
		const made = yield* passagesOf(row);
		if (!Array.isArray(made)) return { state: made } satisfies Prepared;
		const batches = Math.ceil(made.length / BATCH_SIZE);
		const chunked = yield* fenced(row, (locked) =>
			Effect.andThen(passages.replace(locked.id, locked.workspace_id, made), logRow(locked, "chunked", { passages: made.length, batches })),
		);
		if (Option.isNone(chunked)) return { state: "gone" } satisfies Prepared;
		return { state: "chunked", batches } satisfies Prepared;
	});

	const embedBatch = Effect.fn("workspace.embed")(function* (request: IndexRequest, batch: number) {
		const found = yield* current(request);
		if (Option.isNone(found)) return;
		const row = found.value;
		const todo = (yield* passages.batch(row.id, batch, embedder.model)).filter((passage) => !passage.done);
		yield* Tracing.annotate({ "ponder.batch": batch, "ponder.passages": todo.length });
		if (todo.length === 0) return;
		const started = yield* Clock.currentTimeMillis;
		const runId = `workspace-index:${row.id}:${row.generation}:${batch}`;
		const vectors = yield* embedder.embedMany(todo.map(embeddingText), { id: runId, functionId: "workspace-index", user: row.added_by, threadId: null }, INDEX_TIMEOUT);
		const ms = (yield* Clock.currentTimeMillis) - started;
		// Passage ids are the same in each run: a run that a newer one overtook must not write into its passages.
		yield* fenced(row, (locked) =>
			Effect.all([
				passages.saveEmbeddings(
					embedder.model,
					todo.map((passage, index) => ({ id: passage.id, vector: vectors[index] })),
				),
				logRow(locked, "embedded", { batch, passages: todo.length, model: embedder.model, ms }, { part: batch, runId }),
			]),
		);
	});

	const finish = Effect.fn("Indexer.finish")(function* (request: IndexRequest) {
		const found = yield* current(request);
		if (Option.isNone(found)) return "gone" as const;
		const row = found.value;
		const ready = yield* fenced(row, (locked) =>
			Effect.gen(function* () {
				if ((yield* passages.missing(locked.id, embedder.model)) > 0) return false;
				const ms = yield* log.elapsedMs(locked.id, locked.generation);
				const count = yield* passages.count(locked.id);
				yield* store.settle(locked.id, locked.generation, "ready", null);
				yield* logRow(locked, "ready", { passages: count, ms });
				return true;
			}),
		);
		if (Option.isNone(ready)) return "gone" as const;
		if (!ready.value) return yield* failRow(row, "finish", "Some passages have no embedding. Try again.");
		yield* Effect.log(`workspace documents: document ${row.id} of workspace ${row.workspace_id} is ready`);
		return "ready" as const;
	});

	const fail = Effect.fn("Indexer.fail")(function* (request: IndexRequest, stage: IndexStage, error: string) {
		const found = yield* current(request);
		if (Option.isSome(found)) yield* failRow(found.value, stage, error);
	});

	const run = Effect.fn("workspace.index")(function* (request: IndexRequest) {
		let stage: IndexStage = "parse";
		const all = Effect.gen(function* () {
			const prepared = yield* prepare(request);
			if (prepared.state !== "chunked") return prepared.state;
			stage = "embed";
			for (let batch = 0; batch < prepared.batches; batch++) yield* embedBatch(request, batch);
			stage = "finish";
			return yield* finish(request);
		});
		return yield* all.pipe(
			Effect.catchCause((cause) => {
				if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
				return Effect.as(fail(request, stage, failureText(Cause.squash(cause))), "failed" as const);
			}),
		);
	});

	return Indexer.of({ model: embedder.model, prepare, embedBatch, finish, fail, run });
});

export const layer = Layer.effect(Indexer, make);

/** What the person reads when a step failed for a reason of its own: a tagged error's message is built from bounded fields. */
export function failureText(error: unknown) {
	const tagged = error instanceof Error && "_tag" in error;
	return tagged ? `${error.message} Try again.` : "Something went wrong while indexing. Try again.";
}

/** A page read's `runs` row: none when the page could not be sent at all. */
function pageRunId(row: DocumentRow, read: PageRead) {
	return read.attempts > 0 ? `workspace-pdf:${row.id}:${row.generation}:${read.page}` : null;
}

/**
 * A page read's `runs` rows: one for each try that OpenRouter answered, each with its own
 * generation id and cost, so the sweep fills in each cost that comes late. The last is the
 * page's own id, which its log row points to; the tries before it are `<id>:try:<n>`. A
 * page read with no answered try still has its row, for the log row's key.
 */
function pageReadRuns(row: DocumentRow, read: PageRead): Runs.RunRow[] {
	const id = pageRunId(row, read);
	if (!id) return [];
	const calls = read.calls.length ? read.calls : [{ generationId: null, costUsd: null, inputTokens: 0, outputTokens: 0 }];
	return calls.map((call, index) => {
		const last = index === calls.length - 1;
		return {
			id: last ? id : `${id}:try:${index + 1}`,
			parentId: null,
			threadId: null,
			user: row.added_by,
			functionId: "workspace-pdf",
			model: read.model,
			steps: 1,
			inputTokens: call.inputTokens,
			outputTokens: call.outputTokens,
			cachedTokens: 0,
			costUsd: call.costUsd,
			durationMs: last ? read.ms : 0,
			toolCalls: [],
			finishReason: last ? (read.ok ? "stop" : "failed") : "retried",
			generationId: call.generationId,
		};
	});
}
