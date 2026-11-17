import { ApiError, client, unwrap } from "../api";
import { count } from "../numbers";

/**
 * A workspace's documents (server/workspaces/documents/): the list comes with the workspace
 * (store.ts, fetchWorkspace); people who can edit it upload, delete, read the indexing log and
 * ask for "Try again". Written out, so the check without the server (tsconfig.no-node.json)
 * still knows them.
 */
export type DocumentStatus = "reading" | "ready" | "failed";
export type WorkspaceDocument = { id: string; name: string; mediaType: string; size: number; status: DocumentStatus; error: string | null; createdAt: string };

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
	if (file.size > MAX_DOCUMENT_BYTES) throw new ApiError(`"${file.name}" is larger than 10 MB.`, 413);
	const body = new FormData();
	body.append("file", file);
	const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/documents`, { method: "POST", body });
	const answer = (await response.json().catch(() => ({}))) as { document?: WorkspaceDocument; error?: string };
	if (!response.ok || !answer.document) throw new ApiError(answer.error ?? `"${file.name}" could not be uploaded.`, response.status);
	return answer.document;
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

/** A file's size, such as "820 bytes", "14 KB" or "1.2 MB". */
export function fileSize(bytes: number) {
	if (bytes < 1024) return `${count(bytes)} ${bytes === 1 ? "byte" : "bytes"}`;
	if (bytes < 1024 * 1024) return `${count(Math.round(bytes / 1024))} KB`;
	return `${count(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MB`;
}

export const STATUS_LABELS: Record<DocumentStatus, string> = { reading: "Reading…", ready: "Ready", failed: "Failed" };

/** The Details view's footnote, in the dialog and in its stand-in. */
export const DETAILS_NOTE = "Reading documents is paid by the app, not from your credits.";

/** A PDF's icon, or a text file's. */
export function documentIcon(document: Pick<WorkspaceDocument, "mediaType">) {
	if (document.mediaType === "application/pdf") return "lucide-file-text";
	if (document.mediaType === "text/csv" || document.mediaType === "text/tab-separated-values") return "lucide-file-spreadsheet";
	if (document.mediaType === "application/json") return "lucide-file-json";
	return "lucide-file";
}
