import { randomBytes } from "node:crypto";
import * as Option from "effect/Option";
import { sql } from "./db.ts";
import * as ObjectStore from "./files/ObjectStore.ts";
import { prepareImage } from "./image-resize.ts";
import { extractPdfText } from "./pdf-text.ts";
import { pythonEnabled } from "./python/pyodide.ts";
import { runPromise } from "./runtime/runtime.ts";
import * as Settings from "./settings/Settings.ts";

/**
 * Files people attach in the chat. Postgres holds what each file is; the bytes go to
 * the bucket when one is set up (files/ObjectStore.ts, R2 when deployed), or into Postgres
 * too. Messages carry only `/api/files/<id>`, so threads stay small. Before a model call,
 * file-context.ts swaps each link for what the model can read.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const URL_PREFIX = "/api/files/";

/** What the model can read, by media type. Everything else is refused at upload. */
const BINARY_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"]);
export const TEXT_TYPES = new Set(["text/plain", "text/csv", "text/markdown", "application/json", "text/tab-separated-values"]);
const TEXT_EXTENSIONS: Record<string, string> = { csv: "text/csv", tsv: "text/tab-separated-values", txt: "text/plain", md: "text/markdown", json: "application/json" };
const SPREADSHEET = /\.(xlsx|xls|ods)$/i;
/** Spreadsheets only Python can read, so they are taken only while it is on. */
export const SPREADSHEET_TYPES: Record<string, string> = {
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	xls: "application/vnd.ms-excel",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
};

export type StoredFile = { id: string; url: string; name: string; mediaType: string; size: number };

export async function migrateFiles() {
	await sql`
		create table if not exists files (
			id text primary key,
			owner text not null,
			name text not null,
			media_type text not null,
			size integer not null,
			data bytea,
			created_at timestamptz not null default now()
		)`;
	// Bytes in the bucket leave data empty; the key is files/<owner>/<id>.
	await sql`alter table files alter column data drop not null`;
	// A PDF's text: null until it is first read, "" when it has none (a scan).
	await sql`alter table files add column if not exists text text`;
}

/** Stores an upload, or explains in plain words why it can't be used. */
export async function saveFile(owner: string, file: File): Promise<{ file: StoredFile } | { error: string }> {
	if (SPREADSHEET.test(file.name) && !pythonEnabled) return { error: `"${file.name}" is a spreadsheet. Save it as CSV and attach that instead.` };
	if (file.size > MAX_FILE_BYTES) return { error: `"${file.name}" is larger than 10 MB.` };

	const mediaType = mediaTypeOf(file);
	if (!mediaType) return { error: `"${file.name}" can't be read. Attach an image, a PDF, or a CSV, text, Markdown or JSON file.` };

	const checked = await checkContent(Buffer.from(await file.arrayBuffer()), mediaType);
	if (!checked) return { error: `"${file.name}" can't be read. It does not look like ${mediaType === "application/pdf" ? "a PDF" : "an image"}.` };
	const stored = await storeFile(owner, file.name, checked.mediaType, checked.data);
	// Read its text now, so the first reply does not wait for it (file-context.ts).
	if (stored.mediaType === "application/pdf" && (await runPromise(Settings.Settings.use((settings) => settings.get))).pdfTextOnServer) void pdfText(stored.id, { data: checked.data, text: null });
	return { file: stored };
}

/** Images are checked and made smaller (image-resize.ts), PDFs checked by their first bytes. Text is taken as it is. */
async function checkContent(data: Buffer, mediaType: string): Promise<{ data: Buffer; mediaType: string } | undefined> {
	if (mediaType.startsWith("image/")) return prepareImage(data);
	if (mediaType === "application/pdf") return data.subarray(0, 1024).includes("%PDF-") ? { data, mediaType } : undefined;
	return { data, mediaType };
}

/** Stores bytes the server made (a file that Python wrote), the same way as an upload. */
export async function storeFile(owner: string, name: string, mediaType: string, data: Buffer): Promise<StoredFile> {
	const id = randomBytes(12).toString("base64url");
	const store = await runPromise(ObjectStore.ObjectStore);
	if (store.enabled) await runPromise(store.put(objectKey(owner, id), data, mediaType));
	await sql`
		insert into files (id, owner, name, media_type, size, data)
		values (${id}, ${owner}, ${name}, ${mediaType}, ${data.length}, ${store.enabled ? null : data})`;
	return { id, url: `${URL_PREFIX}${id}`, name, mediaType, size: data.length };
}

/** A file by id, only if `owner` uploaded it (or Python wrote it for them). Files are private to their owner. */
export async function loadFile(id: string, owner: string): Promise<LoadedFile | undefined> {
	const [row] = await sql<{ owner: string; name: string; media_type: string; data: Buffer | null; text: string | null }[]>`
		select owner, name, media_type, data, text from files where id = ${id} and owner = ${owner}`;
	if (!row) return undefined;
	const store = await runPromise(ObjectStore.ObjectStore);
	const data = row.data ?? (store.enabled ? Option.getOrUndefined(await runPromise(store.get(objectKey(row.owner, id)))) : undefined);
	return data && { name: row.name, media_type: row.media_type, data, text: row.text };
}

export type LoadedFile = { name: string; media_type: string; data: Buffer; text: string | null };

/** A PDF's text, read the first time it is asked for and kept. "" for a PDF with no text, or one that can't be read. */
export async function pdfText(id: string, file: Pick<LoadedFile, "data" | "text">): Promise<string> {
	if (file.text !== null) return file.text;
	const read = await extractPdfText(file.data).catch((error) => {
		console.warn(`files: could not read the text of PDF ${id}:`, error instanceof Error ? error.message : error);
		return "";
	});
	// Postgres text can't hold a NUL character.
	const text = read.replaceAll("\0", "");
	await sql`update files set text = ${text} where id = ${id}`;
	return text;
}

const objectKey = (owner: string, id: string) => `files/${owner}/${id}`;

function mediaTypeOf(file: File) {
	const type = file.type.split(";")[0].trim().toLowerCase();
	if (BINARY_TYPES.has(type) || TEXT_TYPES.has(type)) return type;
	const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
	return TEXT_EXTENSIONS[extension] ?? (pythonEnabled ? SPREADSHEET_TYPES[extension] : undefined);
}
