import { randomUUID } from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as ObjectStore from "../../files/ObjectStore.ts";
import { MAX_FILE_BYTES, TEXT_EXTENSIONS, TEXT_TYPES } from "../../files.ts";
import * as Workspaces from "../Workspaces.ts";
import * as Indexer from "./Indexer.ts";
import * as IndexRuns from "./IndexRuns.ts";
import { indexLog, type LogEntry } from "./log.ts";
import { passageStore } from "./passages.ts";
import { PDF_TYPE } from "./read-document.ts";
import { documentStore, summaryOf, type DocumentRow, type DocumentSummary } from "./store.ts";

/**
 * A workspace's documents, as its routes use them (docs/workspaces-plan.md, "API"): upload,
 * delete, the indexing log and "Try again", for people who can edit the workspace. The
 * list is in the workspace's detail (Workspaces.get), and each uploaded file opens (file),
 * for everyone who can ask.
 *
 * A document is always read with its workspace's id, after the workspace's access check:
 * one that is not in this workspace is not found.
 */
export type { DocumentSummary } from "./store.ts";

/** The file can't be a document. The reason only: the answer names the file (refusalText). */
export class DocumentRefused extends Schema.TaggedError<DocumentRefused>()("DocumentRefused", {
	reason: Schema.Literals(["too-large", "unknown-type", "not-pdf"]),
}) {
	override get message() {
		return `The document was refused: ${this.reason}.`;
	}
}

export class DocumentNotFound extends Schema.TaggedError<DocumentNotFound>()("DocumentNotFound", {
	documentId: Schema.String,
}) {
	override get message() {
		return "This document was not found.";
	}
}

/** "Try again" is for a document that failed, or whose indexing stopped (stalled). */
export class DocumentNotFailed extends Schema.TaggedError<DocumentNotFailed>()("DocumentNotFailed", {
	documentId: Schema.String,
}) {
	override get message() {
		return "Only a document that failed can be read again.";
	}
}

/**
 * A document Reading for this long with no live run is stalled: its run never started (a
 * crash right after the upload) or ended without settling it. Long enough for a run that
 * is starting to have saved its id.
 */
export const STALLED_AFTER_SECONDS = 5 * 60;

/** Why the file can't be used, in plain words, for the person who uploaded it. */
export function refusalText(name: string, { reason }: DocumentRefused) {
	if (reason === "too-large") return `"${name}" is larger than 10 MB.`;
	if (reason === "not-pdf") return `"${name}" can't be read. It does not look like a PDF.`;
	return `"${name}" can't be read. Upload a PDF, or a text, Markdown, CSV, TSV or JSON file.`;
}

export type DocumentLog = { document: DocumentSummary; steps: LogEntry[] };
export type DocumentFile = { name: string; mediaType: string; data: Buffer };

type AccessErrors = Workspaces.WorkspaceNotFound | Workspaces.WorkspaceRefused | SqlError;

export class Documents extends Context.Service<
	Documents,
	{
		readonly upload: (actor: Workspaces.Actor, workspaceId: string, file: File) => Effect.Effect<DocumentSummary, AccessErrors | DocumentRefused | ObjectStore.ObjectStoreError>;
		readonly remove: (actor: Workspaces.Actor, workspaceId: string, documentId: string) => Effect.Effect<void, AccessErrors | DocumentNotFound>;
		readonly log: (actor: Workspaces.Actor, workspaceId: string, documentId: string) => Effect.Effect<DocumentLog, AccessErrors | DocumentNotFound>;
		readonly retry: (actor: Workspaces.Actor, workspaceId: string, documentId: string) => Effect.Effect<DocumentSummary, AccessErrors | DocumentNotFound | DocumentNotFailed>;
		/** The uploaded file, for the side viewer: anyone who can ask, whatever its status. */
		readonly file: (actor: Workspaces.Actor, workspaceId: string, documentId: string) => Effect.Effect<DocumentFile, AccessErrors | DocumentNotFound | ObjectStore.ObjectStoreError>;
		/** At start-up: index again the ready or reading documents whose passages another embedding model made. Gives how many. */
		readonly reindexOutdated: Effect.Effect<number, SqlError>;
		/** For the sweep: start again the indexing of stalled documents. Gives how many. */
		readonly restartStalled: Effect.Effect<number, SqlError>;
	}
>()("ponder/workspaces/Documents") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const workspaces = yield* Workspaces.Workspaces;
	const indexer = yield* Indexer.Indexer;
	const runs = yield* IndexRuns.IndexRuns;
	const store = documentStore(sql, yield* ObjectStore.ObjectStore);
	const log = indexLog(sql);
	const passages = passageStore(sql);

	/** The document, in a workspace the person can edit. */
	const editable = Effect.fnUntraced(function* (actor: Workspaces.Actor, workspaceId: string, documentId: string) {
		yield* workspaces.check(actor.id, workspaceId, "edit");
		const found = yield* store.find(workspaceId, documentId);
		if (Option.isNone(found)) return yield* new DocumentNotFound({ documentId });
		return found.value;
	});

	/** Starts the run; one that can't start leaves the document Failed, so "Try again" can start it. */
	const startIndexing = Effect.fnUntraced(function* (row: Pick<DocumentRow, "id" | "workspace_id">, generation: number) {
		yield* runs.start({ documentId: row.id, generation }).pipe(
			Effect.flatMap((runId) => store.setRun(row.id, generation, runId)),
			Effect.catchTags({
				IndexNotStarted: (error) =>
					Effect.andThen(Effect.logError(`workspace documents: could not start indexing document ${row.id}:`, error.cause), indexer.fail({ documentId: row.id, generation }, "parse", "Indexing could not start. Try again.")),
			}),
		);
	});

	const upload = Effect.fn("Documents.upload")(function* (actor: Workspaces.Actor, workspaceId: string, file: File) {
		yield* workspaces.check(actor.id, workspaceId, "edit");
		if (file.size > MAX_FILE_BYTES) return yield* new DocumentRefused({ reason: "too-large" });
		const mediaType = documentType(file);
		if (!mediaType) return yield* new DocumentRefused({ reason: "unknown-type" });
		const data = new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()));
		if (mediaType === PDF_TYPE && !Buffer.from(data.subarray(0, 1024)).includes("%PDF-")) return yield* new DocumentRefused({ reason: "not-pdf" });
		const id = randomUUID();
		const name = file.name.trim().slice(0, 200) || "Document";
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* store.create({ id, workspaceId, name, mediaType, data, addedBy: actor.id });
				yield* log.write({ documentId: id, workspaceId, generation: 1, step: "uploaded", detail: { size: data.length, mediaType, by: actor.id } });
			}),
		);
		yield* startIndexing({ id, workspace_id: workspaceId }, 1);
		return summaryOf(Option.getOrThrow(yield* store.find(workspaceId, id)));
	});

	const remove = Effect.fn("Documents.remove")(function* (actor: Workspaces.Actor, workspaceId: string, documentId: string) {
		yield* store.remove(yield* editable(actor, workspaceId, documentId));
	});

	const readLog = Effect.fn("Documents.log")(function* (actor: Workspaces.Actor, workspaceId: string, documentId: string) {
		const row = yield* editable(actor, workspaceId, documentId);
		return { document: summaryOf(row), steps: yield* log.read(row.id) } satisfies DocumentLog;
	});

	const file = Effect.fn("Documents.file")(function* (actor: Workspaces.Actor, workspaceId: string, documentId: string) {
		yield* workspaces.check(actor.id, workspaceId, "ask");
		const row = yield* store.find(workspaceId, documentId);
		if (Option.isNone(row)) return yield* new DocumentNotFound({ documentId });
		const data = yield* store.bytes(row.value);
		if (Option.isNone(data)) return yield* new DocumentNotFound({ documentId });
		return { name: row.value.name, mediaType: row.value.media_type, data: data.value } satisfies DocumentFile;
	});

	/** Reading for a while, with no run going. */
	const stalled = Effect.fnUntraced(function* (row: DocumentRow) {
		const now = yield* Clock.currentTimeMillis;
		if (row.status !== "reading" || now - row.reading_since.getTime() < STALLED_AFTER_SECONDS * 1000) return false;
		return row.index_run_id === null || (yield* runs.status(row.index_run_id)) === "ended";
	});

	const retry = Effect.fn("Documents.retry")(function* (actor: Workspaces.Actor, workspaceId: string, documentId: string) {
		const row = yield* editable(actor, workspaceId, documentId);
		// A stalled one only from the generation read here: a run that took over meanwhile is left alone.
		const generation = (yield* stalled(row)) ? yield* store.restart(row.id, ["reading"], row.generation) : yield* store.restart(row.id, ["failed"]);
		if (Option.isNone(generation)) return yield* new DocumentNotFailed({ documentId });
		yield* log.write({ documentId: row.id, workspaceId, generation: generation.value, step: "reindexed", detail: { reason: "asked", by: actor.id } });
		yield* startIndexing(row, generation.value);
		return summaryOf(Option.getOrThrow(yield* store.find(workspaceId, row.id)));
	});

	/** A new generation for the document, so a run of the one before does nothing more. */
	const claimOutdated = Effect.fnUntraced(function* (document: { id: string; status: "ready" | "reading"; models: ReadonlyArray<string> }) {
		const generation = yield* store.restart(document.id, [document.status]);
		const row = yield* store.byId(document.id);
		if (Option.isNone(generation) || Option.isNone(row)) return Option.none();
		const detail = { reason: "model-changed", from: document.models.join(", "), to: indexer.model };
		yield* log.write({ documentId: document.id, workspaceId: row.value.workspace_id, generation: generation.value, step: "reindexed", detail });
		return Option.some({ row: row.value, generation: generation.value });
	});

	const reindexOutdated = Effect.gen(function* () {
		const outdated = yield* passages.outdated(indexer.model);
		// A document Reading when the model changed holds batches of both models, and its old run would fail it. All
		// are claimed before any run starts: a start also starts Workflow's worker, which resumes the old runs.
		const claimed = Arr.getSomes(yield* Effect.forEach(outdated, claimOutdated));
		for (const { row, generation } of claimed) yield* startIndexing(row, generation);
		if (claimed.length) yield* Effect.log(`workspace documents: indexing ${claimed.length} documents again for the embedding model ${indexer.model}`);
		return claimed.length;
	}).pipe(Effect.withSpan("Documents.reindexOutdated"));

	const restartStalled = Effect.gen(function* () {
		let restarted = 0;
		for (const row of yield* store.readingFor(STALLED_AFTER_SECONDS)) {
			if (!(yield* stalled(row))) continue;
			const generation = yield* store.restart(row.id, ["reading"], row.generation);
			if (Option.isNone(generation)) continue;
			yield* log.write({ documentId: row.id, workspaceId: row.workspace_id, generation: generation.value, step: "reindexed", detail: { reason: "stalled" } });
			yield* startIndexing(row, generation.value);
			restarted++;
		}
		if (restarted) yield* Effect.log(`workspace documents: indexing ${restarted} stalled documents again`);
		return restarted;
	}).pipe(Effect.withSpan("Documents.restartStalled"));

	return Documents.of({ upload, remove, log: readLog, retry, file, reindexOutdated, restartStalled });
});

export const layer = Layer.effect(Documents, make);

/** The same types as a chat attachment, without images and spreadsheets. */
function documentType(file: File) {
	const type = file.type.split(";")[0].trim().toLowerCase();
	if (type === PDF_TYPE || TEXT_TYPES.has(type)) return type;
	const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
	return extension === "pdf" ? PDF_TYPE : TEXT_EXTENSIONS[extension];
}
