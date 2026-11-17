import * as Effect from "effect/Effect";
import type { HeadingRule } from "./markdown-blocks.ts";
import { delimitedToMarkdown } from "./csv.ts";
import { totalChars, type DocumentText } from "./document.ts";
import { readPdf } from "./read-pdf.ts";

/**
 * Reads a document of a workspace into Markdown pages: a PDF with read-pdf.ts, and the
 * text types that a chat attachment takes (TEXT_TYPES in files.ts) as one page with no
 * number. Another type is read as plain text.
 */
export const PDF_TYPE = "application/pdf";

export const readDocument = (mediaType: string, data: Uint8Array) => (mediaType === PDF_TYPE ? readPdf(data) : Effect.succeed(readText(mediaType, data)));

/**
 * How the chunker reads the headings of a document of this type: a PDF's heading levels
 * are guesses (from font sizes, or a model's), so its numbers decide.
 */
export function headingRule(mediaType: string): HeadingRule {
	return mediaType === PDF_TYPE ? "numbered" : "levels";
}

/** A text document: one page, no page number, no model calls. Not an Effect: it does no I/O. */
export function readText(mediaType: string, data: Uint8Array): DocumentText {
	const started = performance.now();
	const markdown = textMarkdown(mediaType, new TextDecoder().decode(data)).trim();
	const pages = markdown ? [{ page: null, markdown }] : [];
	return { engine: "text", pages, pageCount: 1, chars: totalChars(pages), ms: Math.round(performance.now() - started), pageReads: [] };
}

function textMarkdown(mediaType: string, text: string) {
	if (mediaType === "text/csv") return delimitedToMarkdown(text, ",");
	if (mediaType === "text/tab-separated-values") return delimitedToMarkdown(text, "\t");
	if (mediaType === "application/json") return jsonMarkdown(text);
	return text.replace(/\r\n?/g, "\n");
}

/** JSON in a fence, pretty-printed so that the chunker can split it by lines. JSON that does not parse stays as written. */
function jsonMarkdown(text: string) {
	let pretty = text;
	try {
		pretty = JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		// The person may still ask about it.
	}
	return `\`\`\`json\n${pretty.trim()}\n\`\`\``;
}
