import type { UIMessage } from "ai";
import { randomBytes } from "node:crypto";
import { sql } from "./db.ts";
import { getObject, objectStoreEnabled, putObject } from "./object-store.ts";
import { pythonEnabled } from "./python/pyodide.ts";

/**
 * Files people attach in the chat. Postgres holds what each file is; the bytes go to
 * the bucket when one is set up (object-store.ts, R2 when deployed), or into Postgres
 * too. Messages carry only `/api/files/<id>`, so threads stay small. Before a model call,
 * `resolveFileParts` swaps each link for what the model can read: images and PDFs
 * as file data, text files (CSV, Markdown, JSON) as text.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const URL_PREFIX = "/api/files/";

/** What the model can read, by media type. Everything else is refused at upload. */
const BINARY_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"]);
const TEXT_TYPES = new Set(["text/plain", "text/csv", "text/markdown", "application/json", "text/tab-separated-values"]);
const TEXT_EXTENSIONS: Record<string, string> = { csv: "text/csv", tsv: "text/tab-separated-values", txt: "text/plain", md: "text/markdown", json: "application/json" };
const SPREADSHEET = /\.(xlsx|xls|ods)$/i;
/** Spreadsheets only Python can read, so they are taken only while it is on. */
const SPREADSHEET_TYPES: Record<string, string> = {
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
}

/** Stores an upload, or explains in plain words why it can't be used. */
export async function saveFile(owner: string, file: File): Promise<{ file: StoredFile } | { error: string }> {
	if (SPREADSHEET.test(file.name) && !pythonEnabled) return { error: `"${file.name}" is a spreadsheet. Save it as CSV and attach that instead.` };
	if (file.size > MAX_FILE_BYTES) return { error: `"${file.name}" is larger than 10 MB.` };

	const mediaType = mediaTypeOf(file);
	if (!mediaType) return { error: `"${file.name}" can't be read. Attach an image, a PDF, or a CSV, text, Markdown or JSON file.` };

	return { file: await storeFile(owner, file.name, mediaType, Buffer.from(await file.arrayBuffer())) };
}

/** Stores bytes the server made (a file that Python wrote), the same way as an upload. */
export async function storeFile(owner: string, name: string, mediaType: string, data: Buffer): Promise<StoredFile> {
	const id = randomBytes(12).toString("base64url");
	if (objectStoreEnabled) await putObject(objectKey(owner, id), data, mediaType);
	await sql`
		insert into files (id, owner, name, media_type, size, data)
		values (${id}, ${owner}, ${name}, ${mediaType}, ${data.length}, ${objectStoreEnabled ? null : data})`;
	return { id, url: `${URL_PREFIX}${id}`, name, mediaType, size: data.length };
}

/** A file by id, only if `owner` uploaded it (or Python wrote it for them). Files are private to their owner. */
export async function loadFile(id: string, owner: string): Promise<{ name: string; media_type: string; data: Buffer } | undefined> {
	const [row] = await sql<{ owner: string; name: string; media_type: string; data: Buffer | null }[]>`
		select owner, name, media_type, data from files where id = ${id} and owner = ${owner}`;
	if (!row) return undefined;
	const data = row.data ?? (objectStoreEnabled ? await getObject(objectKey(row.owner, id)) : undefined);
	return data && { name: row.name, media_type: row.media_type, data };
}

const objectKey = (owner: string, id: string) => `files/${owner}/${id}`;

/**
 * For the model only: replaces each stored file part with its content. Images and
 * PDFs become data URLs; text files become a text part with the file's text. The
 * saved thread keeps the links. Only the thread owner's files are read: a link to
 * someone else's file reads as "no longer available".
 */
export async function resolveFileParts(messages: UIMessage[], owner: string): Promise<UIMessage[]> {
	return Promise.all(
		messages.map(async (message) => {
			if (!message.parts.some(isStoredFile)) return message;
			const parts = await Promise.all(message.parts.map((part) => (isStoredFile(part) ? resolvePart(part, owner) : [part])));
			return { ...message, parts: parts.flat() };
		}),
	);
}

async function resolvePart(part: Extract<UIMessage["parts"][number], { type: "file" }>, owner: string): Promise<UIMessage["parts"]> {
	const id = part.url.slice(URL_PREFIX.length);
	const file = await loadFile(id, owner);
	if (!file) return [{ type: "text", text: `[The attached file "${part.filename ?? "file"}" is no longer available.]` }];
	const attached = `The person attached "${file.name}" (${file.media_type}, file id ${id}).`;

	if (Object.values(SPREADSHEET_TYPES).includes(file.media_type)) {
		return [{ type: "text", text: `${attached} It is a spreadsheet: read it with run_python, passing this file id as an input.` }];
	}

	if (TEXT_TYPES.has(file.media_type)) {
		const text = file.data.toString("utf8");
		const cut = text.length > MAX_TEXT_CHARS;
		return [
			{
				type: "text",
				text:
					`${attached} Its contents${cut ? `, cut to the first ${MAX_TEXT_CHARS} characters` : ""}:\n\n` +
					"```\n" + (cut ? text.slice(0, MAX_TEXT_CHARS) : text) + "\n```",
			},
		];
	}
	return [
		{ type: "text", text: attached },
		{ ...part, url: `data:${file.media_type};base64,${file.data.toString("base64")}` },
	];
}

function isStoredFile(part: UIMessage["parts"][number]): part is Extract<UIMessage["parts"][number], { type: "file" }> {
	return part.type === "file" && part.url.startsWith(URL_PREFIX);
}

function mediaTypeOf(file: File) {
	const type = file.type.split(";")[0].trim().toLowerCase();
	if (BINARY_TYPES.has(type) || TEXT_TYPES.has(type)) return type;
	const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
	return TEXT_EXTENSIONS[extension] ?? (pythonEnabled ? SPREADSHEET_TYPES[extension] : undefined);
}
