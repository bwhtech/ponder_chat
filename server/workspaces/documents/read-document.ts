import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { delimitedToMarkdown, MAX_TABLE_CHARS, type TableTooLarge } from "./csv.ts";
import { totalChars, type DocumentPage, type DocumentText } from "./document.ts";
import type { HeadingRule } from "./markdown-blocks.ts";

/**
 * Reads a document of a workspace into Markdown pages: the text types that a chat
 * attachment takes (TEXT_TYPES in files.ts) as one page with no number, and another type
 * that is not a PDF as plain text. A PDF is read by read-pdf.ts.
 *
 * Pure, with no I/O and no server code: the worker of prepare-text.ts runs it, off the
 * server's own thread.
 */
export const PDF_TYPE = "application/pdf";

/**
 * How the chunker reads the headings of a document of this type: a PDF's heading levels
 * are guesses (from font sizes, or a model's), so its numbers decide.
 */
export function headingRule(mediaType: string): HeadingRule {
	return mediaType === PDF_TYPE ? "numbered" : "levels";
}

/**
 * The text kept in `workspace_documents.text`: a PDF's pages each start with
 * "--- Page N ---", as pdf-text.ts writes them, so the chunker gets the pages back and a
 * model that reads the whole document can name a page. Postgres text can't hold NUL.
 */
export function storedText(pages: ReadonlyArray<DocumentPage>) {
	const text = pages.map((page) => (page.page === null ? page.markdown : `--- Page ${page.page} ---\n${page.markdown}`)).join("\n\n");
	return text.replaceAll("\0", "");
}

/** The pages of a stored text. */
export function storedPages(mediaType: string, text: string): DocumentPage[] {
	if (mediaType === PDF_TYPE) return pdfTextPages(text);
	return text ? [{ page: null, markdown: text }] : [];
}

/** pdf-text.ts marks each page with "--- Page N ---". */
export function pdfTextPages(text: string): DocumentPage[] {
	const parts = text.split(/^--- Page (\d+) ---$/m);
	const pages: DocumentPage[] = [];
	for (let index = 1; index < parts.length; index += 2) pages.push({ page: Number(parts[index]), markdown: parts[index + 1].trim() });
	return pages;
}

/**
 * A text document: one page, no page number, no model calls. Not an Effect: it does no I/O.
 * Markdown and plain text never grow; a table or JSON that would is bounded (csv.ts, jsonMarkdown).
 */
export function readText(mediaType: string, data: Uint8Array): Result.Result<DocumentText, TableTooLarge> {
	const started = performance.now();
	return Result.map(textMarkdown(mediaType, new TextDecoder().decode(data)), (text): DocumentText => {
		const markdown = text.trim();
		const pages = markdown ? [{ page: null, markdown }] : [];
		return { engine: "text", pages, pageCount: 1, chars: totalChars(pages), ms: Math.round(performance.now() - started), pageReads: [] };
	});
}

function textMarkdown(mediaType: string, text: string): Result.Result<string, TableTooLarge> {
	if (mediaType === "text/csv") return delimitedToMarkdown(text, ",");
	if (mediaType === "text/tab-separated-values") return delimitedToMarkdown(text, "\t");
	if (mediaType === "application/json") return Result.succeed(jsonMarkdown(text));
	return Result.succeed(text.replace(/\r\n?/g, "\n"));
}

/**
 * JSON in a fence, pretty-printed so that the chunker can split it by lines. JSON that does
 * not parse stays as written, and so does JSON whose indents would make it too large: each
 * line of a deeply nested value repeats its indent.
 */
function jsonMarkdown(text: string) {
	let pretty = text;
	try {
		const value: unknown = JSON.parse(text);
		if (prettyChars(value, 0, MAX_TABLE_CHARS) <= MAX_TABLE_CHARS) pretty = JSON.stringify(value, null, 2);
	} catch {
		// The person may still ask about it.
	}
	return `\`\`\`json\n${pretty.trim()}\n\`\`\``;
}

/**
 * About the length of JSON.stringify(value, null, 2), counted without building it. Stops
 * counting once past `limit`. Each item of an array or object is on a line of its own,
 * indented 2 spaces for each level.
 */
function prettyChars(value: unknown, depth: number, limit: number): number {
	if (!Predicate.isObjectOrArray(value)) return JSON.stringify(value)?.length ?? 4;
	const entries = Array.isArray(value) ? value.map((item) => ["", item] as const) : Object.entries(value).map(([key, item]) => [`${JSON.stringify(key)}: `, item] as const);
	let chars = 3 + 2 * depth;
	for (const [key, item] of entries) {
		chars += 2 + 2 * (depth + 1) + key.length + prettyChars(item, depth + 1, limit - chars);
		if (chars > limit) return chars;
	}
	return chars;
}
