import * as Schema from "effect/Schema";

/**
 * What reading a document gives: its text as Markdown, one entry for each page, and the
 * records that the indexing log and `runs` keep. The chunker (chunk.ts) splits the pages
 * into passages.
 */

/** One page's Markdown. `page` is the page number in a PDF, and null for a text document. */
export type DocumentPage = { page: number | null; markdown: string };

/** Why a page went to a model: one picture covers 10% of it or more, or the whole page is one scanned picture. */
export type PageReadReason = "picture" | "scan";

/** One try that OpenRouter answered, and so may have billed: its own `runs` row, so a cost that comes later is filled in for each. */
export const PageCall = Schema.Struct({
	generationId: Schema.NullOr(Schema.String),
	costUsd: Schema.NullOr(Schema.Number),
	inputTokens: Schema.Number,
	outputTokens: Schema.Number,
});
export type PageCall = typeof PageCall.Type;

/**
 * One page that a model read, for the `page-read` log row and its `runs` rows.
 * Never the page's text: only numbers, ids, the model and the error.
 */
export const PageRead = Schema.Struct({
	page: Schema.Number,
	reason: Schema.Literals(["picture", "scan"]),
	model: Schema.String,
	ok: Schema.Boolean,
	/** Why the call failed, cut to 300 characters. Null when it worked. */
	error: Schema.NullOr(Schema.String),
	/** The time of all attempts together. */
	ms: Schema.Number,
	/** 0 when the page could not be sent at all. */
	attempts: Schema.Number,
	/** OpenRouter's cost in US dollars, for all attempts. Null when OpenRouter did not say (a failed call). */
	costUsd: Schema.NullOr(Schema.Number),
	inputTokens: Schema.Number,
	outputTokens: Schema.Number,
	reasoningTokens: Schema.Number,
	/** OpenRouter's generation id ("gen-...") of the last try that has one. */
	generationId: Schema.NullOr(Schema.String),
	/** Each try that OpenRouter answered, in order. */
	calls: Schema.Array(PageCall),
	/** The length of the model's text. 0 when the call failed. */
	chars: Schema.Number,
});
export type PageRead = typeof PageRead.Type;

/** How the text was read: LiteParse, pdf.js when LiteParse does not load, or as text. */
export type ReadEngine = "liteparse" | "pdf-text" | "text";

export type DocumentText = {
	engine: ReadEngine;
	pages: DocumentPage[];
	/** Pages in the PDF; 1 for a text document. */
	pageCount: number;
	/** Characters of Markdown in all pages. */
	chars: number;
	/** The time to read the whole document, model calls included. */
	ms: number;
	/** The model calls, in page order. Empty for a text document. */
	pageReads: PageRead[];
};

/** LiteParse or pdf.js could not read the PDF, or it has no text at all (a scan, read without LiteParse). */
export class PdfUnreadable extends Schema.TaggedError<PdfUnreadable>()("PdfUnreadable", {
	reason: Schema.Literals(["failed", "no-text"]),
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		return this.reason === "no-text" ? "The PDF has no text that could be read." : "The PDF could not be read.";
	}
}

/** OpenRouter errors are cut to this length in the log, as elsewhere in Ponder. */
export const MAX_ERROR = 300;

export function cutError(text: string) {
	return text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text;
}

export function totalChars(pages: ReadonlyArray<DocumentPage>) {
	return pages.reduce((sum, page) => sum + page.markdown.length, 0);
}
