import { randomUUID } from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
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
 * list is in the workspace's detail (Workspaces.get), for everyone who can ask.
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

/** "Try again" is for a document that failed. */
export class DocumentNotFailed extends Schema.TaggedError<DocumentNotFailed>()("DocumentNotFailed", {
	documentId: Schema.String,
}) {
	override get message() {
		return "Only a document that failed can be read again.";
	}
}

/** Why the file can't be used, in plain words, for the person who uploaded it. */
export function refusalText(name: string, { reason }: DocumentRefused) {
	if (reason === "too-large") return `"${name}" is larger than 10 MB.`;
	if (reason === "not-pdf") return `"${name}" can't be read. It does not look like a PDF.`;
	return `"${name}" can't be read. Upload a PDF, or a text, Markdown, CSV, TSV or JSON file.`;
}

export type DocumentLog = { document: DocumentSummary; steps: LogEntry[] };

type AccessErrors = Workspaces.WorkspaceNotFound | Workspaces.WorkspaceRefused | SqlError;

export class Documents extends Context.Service<
	Documents,
	{
		readonly upload: (actor: Workspaces.Actor, workspaceId: string, file: File) => Effect.Effect<DocumentSummary, AccessErrors | DocumentRefused | ObjectStore.ObjectStoreError>;
		readonly remove: (actor: Workspaces.Actor, workspaceId: string, documentId: string) => Effect.Effect<void, AccessErrors | DocumentNotFound>;
		readonly log: (actor: Workspaces.Actor, workspaceId: string, documentId: string) => Effect.Effect<DocumentLog, AccessErrors | DocumentNotFound>;
		readonly retry: (actor: Workspaces.Actor, workspaceId: string, documentId: string) => Effect.Effect<DocumentSummary, AccessErrors | DocumentNotFound | DocumentNotFailed>;
		/** At start-up: index again the ready documents whose passages another embedding model made. Gives how many. */
		readonly reindexOutdated: Effect.Effect<number, SqlError>;
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

	const retry = Effect.fn("Documents.retry")(function* (actor: Workspaces.Actor, workspaceId: string, documentId: string) {
		const row = yield* editable(actor, workspaceId, documentId);
		const generation = yield* store.restart(row.id, ["failed"]);
		if (Option.isNone(generation)) return yield* new DocumentNotFailed({ documentId });
		yield* log.write({ documentId: row.id, workspaceId, generation: generation.value, step: "reindexed", detail: { reason: "asked", by: actor.id } });
		yield* startIndexing(row, generation.value);
		return summaryOf(Option.getOrThrow(yield* store.find(workspaceId, row.id)));
	});

	const reindexOutdated = Effect.gen(function* () {
		const outdated = yield* passages.outdated(indexer.model);
		for (const document of outdated) {
			const generation = yield* store.restart(document.id, ["ready"]);
			const row = yield* store.byId(document.id);
			if (Option.isNone(generation) || Option.isNone(row)) continue;
			const detail = { reason: "model-changed", from: document.models.join(", "), to: indexer.model };
			yield* log.write({ documentId: document.id, workspaceId: row.value.workspace_id, generation: generation.value, step: "reindexed", detail });
			yield* startIndexing(row.value, generation.value);
		}
		if (outdated.length) yield* Effect.log(`workspace documents: indexing ${outdated.length} documents again for the embedding model ${indexer.model}`);
		return outdated.length;
	}).pipe(Effect.withSpan("Documents.reindexOutdated"));

	return Documents.of({ upload, remove, log: readLog, retry, reindexOutdated });
});

export const layer = Layer.effect(Documents, make);

/** The same types as a chat attachment, without images and spreadsheets. */
function documentType(file: File) {
	const type = file.type.split(";")[0].trim().toLowerCase();
	if (type === PDF_TYPE || TEXT_TYPES.has(type)) return type;
	const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
	return extension === "pdf" ? PDF_TYPE : TEXT_EXTENSIONS[extension];
}
