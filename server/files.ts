import { randomBytes } from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as PonderConfig from "./config.ts";
import * as ObjectStore from "./files/ObjectStore.ts";
import { prepareImage, type PreparedImage } from "./image-resize.ts";
import * as PdfText from "./pdf-text.ts";
import { sqlMessage } from "./runtime/Database.ts";
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
export const TEXT_EXTENSIONS: Record<string, string> = { csv: "text/csv", tsv: "text/tab-separated-values", txt: "text/plain", md: "text/markdown", json: "application/json" };
const SPREADSHEET = /\.(xlsx|xls|ods)$/i;
/** Spreadsheets only Python can read, so they are taken only while it is on. */
export const SPREADSHEET_TYPES: Record<string, string> = {
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	xls: "application/vnd.ms-excel",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
};
/** What the model reads cannot run script, so it opens in the browser. */
const INLINE_TYPES = new Set([...BINARY_TYPES, ...TEXT_TYPES]);

/**
 * The headers of a stored file's bytes (a chat file, a workspace document), all but its cache
 * policy. Other types (HTML or SVG that Python wrote) download, sandboxed.
 */
export function fileHeaders(name: string, mediaType: string): Record<string, string> {
	const inline = INLINE_TYPES.has(mediaType);
	return {
		"Content-Type": mediaType,
		"Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
		"X-Content-Type-Options": "nosniff",
		...(!inline && { "Content-Security-Policy": "default-src 'none'; sandbox" }),
	};
}

export type StoredFile = { id: string; url: string; name: string; mediaType: string; size: number };
export type LoadedFile = { name: string; media_type: string; data: Buffer; text: string | null };

/**
 * An upload that can't be used. The reason only: the answer to the person names the file
 * (refusalText), which an error never holds.
 */
export class FileRefused extends Schema.TaggedError<FileRefused>()("FileRefused", {
	reason: Schema.Literals(["spreadsheet", "too-large", "unknown-type", "not-pdf", "not-image"]),
}) {
	override get message() {
		return `The file was refused: ${this.reason}.`;
	}
}

/** Why the file can't be used, in plain words, for the person who attached it. */
export function refusalText(name: string, { reason }: FileRefused) {
	if (reason === "spreadsheet") return `"${name}" is a spreadsheet. Save it as CSV and attach that instead.`;
	if (reason === "too-large") return `"${name}" is larger than 10 MB.`;
	if (reason === "unknown-type") return `"${name}" can't be read. Attach an image, a PDF, or a CSV, text, Markdown or JSON file.`;
	return `"${name}" can't be read. It does not look like ${reason === "not-pdf" ? "a PDF" : "an image"}.`;
}

const FileRow = Schema.Struct({
	owner: Schema.String,
	name: Schema.String,
	media_type: Schema.String,
	data: Schema.NullOr(Schema.Uint8Array),
	text: Schema.NullOr(Schema.String),
});
const FileOfOwner = Schema.Struct({ id: Schema.String, owner: Schema.String });

export class Files extends Context.Service<
	Files,
	{
		/** Creates and updates the `files` table. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** Stores an upload, or refuses it (FileRefused). */
		readonly save: (owner: string, file: File) => Effect.Effect<StoredFile, FileRefused | SqlError | ObjectStore.ObjectStoreError>;
		/** Stores bytes the server made (a file that Python wrote), the same way as an upload. */
		readonly store: (owner: string, name: string, mediaType: string, data: Buffer) => Effect.Effect<StoredFile, SqlError | ObjectStore.ObjectStoreError>;
		/** A file by id, only if `owner` uploaded it (or Python wrote it for them). Files are private to their owner. */
		readonly load: (id: string, owner: string) => Effect.Effect<Option.Option<LoadedFile>, SqlError | ObjectStore.ObjectStoreError>;
		/** A PDF's text, read the first time it is asked for and kept. "" for a PDF with no text, or one that can't be read. */
		readonly pdfText: (id: string, file: Pick<LoadedFile, "data" | "text">) => Effect.Effect<string, SqlError>;
	}
>()("ponder/files/Files") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const config = yield* PonderConfig.PonderConfig;
	const objects = yield* ObjectStore.ObjectStore;
	const settings = yield* Settings.Settings;
	const pdf = yield* PdfText.PdfText;
	// A PDF's text is read after the upload has answered, in the layer's scope.
	const scope = yield* Effect.scope;

	const migrate = Effect.gen(function* () {
		yield* sql`
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
		yield* sql`alter table files alter column data drop not null`;
		// A PDF's text: null until it is first read, "" when it has none (a scan).
		yield* sql`alter table files add column if not exists text text`;
	});

	const findFile = SqlSchema.findOneOption({
		Request: FileOfOwner,
		Result: FileRow,
		execute: ({ id, owner }) => sql`select owner, name, media_type, data, text from files where id = ${id} and owner = ${owner}`,
	});

	const store = Effect.fn("Files.store")(function* (owner: string, name: string, mediaType: string, data: Buffer) {
		const id = randomBytes(12).toString("base64url");
		if (objects.enabled) yield* objects.put(objectKey(owner, id), data, mediaType);
		yield* sql`
			insert into files (id, owner, name, media_type, size, data)
			values (${id}, ${owner}, ${name}, ${mediaType}, ${data.length}, ${objects.enabled ? null : data})`;
		return { id, url: `${URL_PREFIX}${id}`, name, mediaType, size: data.length } satisfies StoredFile;
	});

	const load = Effect.fn("Files.load")(function* (id: string, owner: string) {
		const found = yield* findFile({ id, owner }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		if (Option.isNone(found)) return Option.none<LoadedFile>();
		const row = found.value;
		const data = row.data
			? Option.some(Buffer.from(row.data))
			: objects.enabled
				? yield* objects.get(objectKey(row.owner, id))
				: Option.none<Buffer>();
		return Option.map(data, (bytes): LoadedFile => ({ name: row.name, media_type: row.media_type, data: bytes, text: row.text }));
	});

	const pdfText = Effect.fn("Files.pdfText")(function* (id: string, file: Pick<LoadedFile, "data" | "text">) {
		if (file.text !== null) return file.text;
		const read = yield* pdf.extract(file.data).pipe(
			Effect.catchTags({
				PdfTextError: (error) =>
					Effect.as(Effect.logWarning(`files: could not read the text of PDF ${id}:`, error.cause instanceof Error ? error.cause.message : error.message), ""),
			}),
		);
		// Postgres text can't hold a NUL character.
		const text = read.replaceAll("\0", "");
		yield* sql`update files set text = ${text} where id = ${id}`;
		return text;
	});

	/** Images are checked and made smaller (image-resize.ts), PDFs checked by their first bytes. Text is taken as it is. */
	const checkContent = (data: Buffer, mediaType: string): Effect.Effect<Option.Option<PreparedImage>> => {
		if (mediaType.startsWith("image/")) return prepareImage(data);
		if (mediaType === "application/pdf") return Effect.succeed(data.subarray(0, 1024).includes("%PDF-") ? Option.some({ data, mediaType }) : Option.none());
		return Effect.succeed(Option.some({ data, mediaType }));
	};

	const mediaTypeOf = (file: File) => {
		const type = file.type.split(";")[0].trim().toLowerCase();
		if (BINARY_TYPES.has(type) || TEXT_TYPES.has(type)) return type;
		const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
		return TEXT_EXTENSIONS[extension] ?? (config.pythonEnabled ? SPREADSHEET_TYPES[extension] : undefined);
	};

	const save = Effect.fn("Files.save")(function* (owner: string, file: File) {
		if (SPREADSHEET.test(file.name) && !config.pythonEnabled) return yield* new FileRefused({ reason: "spreadsheet" });
		if (file.size > MAX_FILE_BYTES) return yield* new FileRefused({ reason: "too-large" });

		const mediaType = mediaTypeOf(file);
		if (!mediaType) return yield* new FileRefused({ reason: "unknown-type" });

		const bytes = Buffer.from(yield* Effect.promise(() => file.arrayBuffer()));
		const checked = yield* checkContent(bytes, mediaType);
		if (Option.isNone(checked)) return yield* new FileRefused({ reason: mediaType === "application/pdf" ? "not-pdf" : "not-image" });
		const stored = yield* store(owner, file.name, checked.value.mediaType, checked.value.data);
		// Read its text now, so the first reply does not wait for it (file-context.ts).
		if (stored.mediaType === "application/pdf" && (yield* settings.get).pdfTextOnServer) {
			yield* pdfText(stored.id, { data: checked.value.data, text: null }).pipe(
				Effect.catchTags({ SqlError: (error) => Effect.logWarning(`files: could not save the text of PDF ${stored.id}:`, sqlMessage(error)) }),
				Effect.forkIn(scope),
			);
		}
		return stored;
	});

	return Files.of({ migrate, save, store, load, pdfText });
});

export const layer = Layer.effect(Files, make);

const objectKey = (owner: string, id: string) => `files/${owner}/${id}`;
