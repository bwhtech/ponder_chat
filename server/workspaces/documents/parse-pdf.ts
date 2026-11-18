import { readTextLayer } from "../../pdfjs-text.ts";
import { dropRepeatedLines } from "./boilerplate.ts";
import { totalChars } from "./document.ts";
import { parseWithLiteParse, type LiteParsePage } from "./liteparse.ts";
import { MAX_PAGES, MAX_TEXT_CHARS } from "./limits.ts";
import type { JobAnswer, JobFailure } from "./prepare-text.ts";

/**
 * Reads a PDF's pages in the worker of prepare-text.ts: with LiteParse, or with pdf.js's
 * text layer when LiteParse does not load here. Then it drops the repeated header and
 * footer lines (boilerplate.ts), which goes over every line of every page. The server
 * gets only the pages' Markdown, within MAX_PAGES and MAX_TEXT_CHARS. read-pdf.ts sends
 * the picture pages to a model.
 *
 * Plain async code with no server code: the worker imports it.
 */
export type ParsedPdf = {
	readonly engine: "liteparse" | "pdf-text";
	/** Pages in the PDF. */
	readonly pageCount: number;
	/** Each page's Markdown, and why it must go to a model. With pdf.js, none goes. */
	readonly pages: LiteParsePage[];
};

export async function parsePdf(data: Uint8Array): Promise<JobAnswer<ParsedPdf>> {
	const read = await readPages(data);
	if ("failed" in read) return read;
	if (read.pageCount > MAX_PAGES) return tooLarge("pages");
	if (totalChars(read.pages) > MAX_TEXT_CHARS) return tooLarge("text");
	return { ok: { ...read, pages: dropRepeatedLines(read.pages) } };
}

async function readPages(data: Uint8Array): Promise<ParsedPdf | { failed: JobFailure }> {
	let parsed;
	try {
		parsed = await parseWithLiteParse(data, MAX_PAGES);
	} catch (cause) {
		return { failed: { tag: "PdfUnreadable", reason: "failed", cause } };
	}
	return parsed ? { engine: "liteparse", ...parsed } : await textLayerPages(data);
}

async function textLayerPages(data: Uint8Array): Promise<ParsedPdf | { failed: JobFailure }> {
	let layer;
	try {
		layer = await readTextLayer(data, { maxPages: MAX_PAGES, maxChars: MAX_TEXT_CHARS });
	} catch (cause) {
		return { failed: { tag: "PdfUnreadable", reason: "failed", cause } };
	}
	if ("tooLarge" in layer) return tooLarge(layer.tooLarge);
	if (layer.pages.length === 0) return { failed: { tag: "PdfUnreadable", reason: "no-text" } };
	const pages = layer.pages.map((markdown, index): LiteParsePage => ({ page: index + 1, markdown, modelReason: null }));
	return { engine: "pdf-text", pageCount: pages.length, pages };
}

function tooLarge(reason: "pages" | "text") {
	return { failed: { tag: "DocumentTooLarge", reason } } satisfies { failed: JobFailure };
}
