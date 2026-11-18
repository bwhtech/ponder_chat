import type { ViewedFile } from "frappe-ui-ai-elements";
import { ApiError, client, unwrap } from "../api";
import { isRecord } from "../json";
import { count } from "../numbers";

/**
 * A workspace's documents (server/workspaces/documents/): the list comes with the workspace
 * (store.ts, fetchWorkspace), and everyone who can ask opens each file in the side viewer;
 * people who can edit it upload, delete, read the indexing log and ask for "Try again".
 */
export type DocumentStatus = "reading" | "ready" | "failed";
/**
 * How far an Indexing document is (server/workspaces/documents/store.ts, progressOf): the
 * pages whose text is ready while a model reads a PDF's pictures, then the passages embedded.
 */
export type DocumentProgress = { phase: "pages" | "embedding"; done: number; total: number };
export type WorkspaceDocument = {
	id: string;
	name: string;
	mediaType: string;
	size: number;
	status: DocumentStatus;
	error: string | null;
	createdAt: string;
	/** Null unless it is Indexing and there is something to count. */
	progress: DocumentProgress | null;
};

export type LogStep = "uploaded" | "reindexed" | "parsed" | "page-read" | "chunked" | "embedded" | "ready" | "failed";
/** One step of the indexing log: numbers, page numbers, model names and errors, never document text. */
export type LogEntry = { generation: number; step: LogStep; at: string; detail: Record<string, string | number | boolean | null>; costUsd: number | null };
export type DocumentLog = { document: WorkspaceDocument; steps: LogEntry[] };

/** The same limit as a chat attachment (server/files.ts). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** The file picker's types: the server decides, and says why it refuses one. */
export const DOCUMENT_TYPES = "application/pdf,.pdf,.txt,.md,.csv,.tsv,.json,text/plain,text/markdown,text/csv,text/tab-separated-values,application/json";

const param = (workspaceId: string, documentId?: string) => ({ id: encodeURIComponent(workspaceId), doc: encodeURIComponent(documentId ?? "") });

/**
 * Sends one file. A form, not the typed client: the route reads the form itself. A file over
 * the limit is refused here, in the server's words, so ten megabytes are not sent for nothing.
 */
export async function uploadDocument(workspaceId: string, file: File): Promise<WorkspaceDocument> {
	if (file.size > MAX_DOCUMENT_BYTES) throw new ApiError(`“${file.name}” is larger than 10 MB.`, 413);
	const body = new FormData();
	body.append("file", file);
	const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/documents`, { method: "POST", body });
	const answer: unknown = await response.json().catch(() => ({}));
	if (response.ok && isRecord(answer) && isWorkspaceDocument(answer.document)) return answer.document;
	const error = isRecord(answer) && typeof answer.error === "string" ? answer.error : undefined;
	throw new ApiError(error ?? `“${file.name}” could not be uploaded.`, response.status);
}

export async function deleteDocument(workspaceId: string, documentId: string) {
	await unwrap(client.api.workspaces[":id"].documents[":doc"].$delete({ param: param(workspaceId, documentId) }), "The document could not be deleted.");
}

export async function retryDocument(workspaceId: string, documentId: string): Promise<WorkspaceDocument> {
	return (await unwrap(client.api.workspaces[":id"].documents[":doc"].retry.$post({ param: param(workspaceId, documentId) }), "The document could not be read again.")).document;
}

export async function fetchDocumentLog(workspaceId: string, documentId: string): Promise<DocumentLog> {
	return unwrap(client.api.workspaces[":id"].documents[":doc"].log.$get({ param: param(workspaceId, documentId) }), "The details could not load.");
}

/** The uploaded file, as the side viewer opens it, for everyone who can ask. */
export function documentFile(workspaceId: string, document: WorkspaceDocument): ViewedFile {
	const { id, doc } = param(workspaceId, document.id);
	return { name: document.name, mediaType: document.mediaType, url: `/api/workspaces/${id}/documents/${doc}/file` };
}

/** A file's size, such as "820 bytes", "14 KB" or "1.2 MB". */
export function fileSize(bytes: number) {
	if (bytes < 1024) return `${count(bytes)} ${bytes === 1 ? "byte" : "bytes"}`;
	if (bytes < 1024 * 1024) return `${count(Math.round(bytes / 1024))} KB`;
	return `${count(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MB`;
}

export const STATUS_LABELS: Record<DocumentStatus, string> = { reading: "Indexing…", ready: "Ready", failed: "Failed" };

/**
 * Why a document failed, in a few words: the row's status ("2.3 MB · Could not read page 3")
 * and the title of the step that failed in Details say the same. A page the model could not
 * read is named by its number (server/workspaces/documents/read-pdf.ts). The admin's log keeps
 * the server's own words.
 */
export function failureReason(error: string | null) {
	const page = /^Page (\d+)\b/.exec(error ?? "");
	if (page) return `Could not read page ${page[1]}`;
	if (/\bno text\b/.test(error ?? "")) return "Found no text to read";
	if (/^This table is too/.test(error ?? "")) return "The table is too large";
	if (/too large (or complex )?to read/.test(error ?? "")) return "Too large to read";
	return "Could not read it";
}

/** A failure's cause, when it has plain words (a model's own error has none): the line under the failed step in Details. */
export function failureCause(error: string | null) {
	if (/time(d)? ?out/i.test(error ?? "")) return "It took too long.";
	if (/missing from storage/.test(error ?? "")) return "The file is missing. Upload it again.";
	// The reader ran out of memory (server/workspaces/documents/prepare-text.ts).
	if (/too large or complex/.test(error ?? "")) return "It is too large or complex to read. Split it into smaller files.";
	// The server's own words (csv.ts, limits.ts): what is too large, and what to change.
	if (/^(This table is too|The document is too large to read:)/.test(error ?? "")) return error;
	return null;
}

/** A PDF's icon, or a text file's. */
export function documentIcon(document: Pick<WorkspaceDocument, "mediaType">) {
	if (document.mediaType === "application/pdf") return "lucide-file-text";
	if (document.mediaType === "text/csv" || document.mediaType === "text/tab-separated-values") return "lucide-file-spreadsheet";
	if (document.mediaType === "application/json") return "lucide-file-json";
	return "lucide-file";
}

const STATUSES = new Set<unknown>(["reading", "ready", "failed"] satisfies DocumentStatus[]);

function isWorkspaceDocument(value: unknown): value is WorkspaceDocument {
	return (
		isRecord(value) &&
		[value.id, value.name, value.mediaType, value.createdAt].every((field) => typeof field === "string") &&
		typeof value.size === "number" &&
		STATUSES.has(value.status) &&
		(value.error === null || typeof value.error === "string") &&
		(value.progress === null || isProgress(value.progress))
	);
}

function isProgress(value: unknown): value is DocumentProgress {
	return isRecord(value) && (value.phase === "pages" || value.phase === "embedding") && typeof value.done === "number" && typeof value.total === "number";
}
