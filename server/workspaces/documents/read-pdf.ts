import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as PdfText from "../../pdf-text.ts";
import * as Tracing from "../../tracing/Tracing.ts";
import { dropRepeatedLines } from "./boilerplate.ts";
import { PageRead, totalChars, type DocumentPage, type DocumentText, type PageReadReason } from "./document.ts";
import { parseWithLiteParse, type LiteParsePage } from "./liteparse.ts";
import * as PageReader from "./page-reader.ts";
import { onePagePdfs } from "./pdf-pages.ts";

/**
 * Reads a PDF into Markdown pages (docs/workspaces-plan.md, "PDF reading"):
 *
 * 1. LiteParse reads every page, with no cost.
 * 2. A page where one picture covers 10% or more, or that is one scanned picture, goes to
 *    a model (PageReader). Its text takes the place of LiteParse's for that page.
 * 3. A page with no text whose model call fails fails the whole read, with its page
 *    number: a document is never "Ready" with pages missing. A picture page whose call
 *    fails keeps LiteParse's text, and its record says so.
 *
 * When LiteParse does not load here, the text layer is read with pdf-text.ts instead, and
 * no page goes to a model.
 *
 * Each page read is paid for. The indexer gives a checkpoint: the pages read so far in its
 * run are used again, each new one is kept as soon as it ends, and the read stops before
 * its next batch once a newer run took over or the document is gone.
 */
// Pages are copied and read a few at a time, so a scanned book of 400 pages is never all
// in memory at once, and a page with no text that fails stops the read early.
const BATCH = 8;
const CALLS_AT_ONCE = 4;

/** LiteParse or pdf.js could not read the PDF, or it has no text at all (a scan, read without LiteParse). */
export class PdfUnreadable extends Schema.TaggedError<PdfUnreadable>()("PdfUnreadable", {
	reason: Schema.Literals(["failed", "no-text"]),
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		return this.reason === "no-text" ? "The PDF has no text that could be read." : "The PDF could not be read.";
	}
}

/** The pages read so far, how to keep each new one, and whether the run is still wanted. */
export type PageCheckpoint = {
	readonly done: ReadonlyMap<number, PageReader.PageReadResult>;
	readonly save: (result: PageReader.PageReadResult) => Effect.Effect<void, SqlError>;
	/** False once a newer run took over, or the document is settled or gone. */
	readonly live: Effect.Effect<boolean, SqlError>;
};

/** For a read with nothing to keep: a test, the test questions. */
export const NO_CHECKPOINT: PageCheckpoint = { done: new Map(), save: () => Effect.void, live: Effect.succeed(true) };

/** A newer run took over, or the document is gone: no more pages are paid for. */
export class ReadStopped extends Schema.TaggedError<ReadStopped>()("ReadStopped", {}) {
	override get message() {
		return "The read stopped: a newer run took over, or the document is gone.";
	}
}

/** A page with no text that the model could not read. `pageReads` are the calls made so far, for the log. */
export class PageUnreadable extends Schema.TaggedError<PageUnreadable>()("PageUnreadable", {
	page: Schema.Number,
	pageReads: Schema.Array(PageRead),
}) {
	override get message() {
		return `Page ${this.page} has no text, and the model could not read it.`;
	}
}

export const readPdf = Effect.fn("PdfReader.read")(function* (data: Uint8Array, checkpoint: PageCheckpoint = NO_CHECKPOINT) {
	const started = yield* Clock.currentTimeMillis;
	yield* Tracing.annotate({ "ponder.bytes": data.length });
	const parsed = yield* parseWithLiteParse(data).pipe(Effect.catchTags({ LiteParseFailed: (error) => Effect.fail(new PdfUnreadable({ reason: "failed", cause: error.cause })) }));
	const read = Option.isSome(parsed) ? yield* withModelPages(data, parsed.value.pages, parsed.value.pageCount, checkpoint) : yield* withPdfText(data);
	const done: DocumentText = { ...read, chars: totalChars(read.pages), ms: (yield* Clock.currentTimeMillis) - started };
	yield* Tracing.annotate({ "ponder.pages": done.pageCount, "ponder.chars": done.chars, "ponder.page_reads": done.pageReads.length });
	return done;
});

type Read = Omit<DocumentText, "chars" | "ms">;

const withModelPages = Effect.fnUntraced(function* (data: Uint8Array, parsed: LiteParsePage[], pageCount: number, checkpoint: PageCheckpoint) {
	const pages = dropRepeatedLines(parsed);
	const toModel = pages.flatMap((page) => (Option.isSome(page.modelReason) ? [{ page: page.page, reason: page.modelReason.value, hasText: hasText(page.markdown) }] : []));
	const texts = new Map<number, string>();
	const pageReads: PageRead[] = [];
	for (let start = 0; start < toModel.length; start += BATCH) {
		const batch = toModel.slice(start, start + BATCH);
		if (!(yield* checkpoint.live)) return yield* new ReadStopped();
		const results = yield* readBatch(data, batch, checkpoint);
		for (const [index, result] of results.entries()) {
			pageReads.push(result.record);
			if (Option.isSome(result.text)) texts.set(batch[index].page, result.text.value);
		}
		const missing = batch.find((page) => !page.hasText && !texts.has(page.page));
		if (missing) return yield* new PageUnreadable({ page: missing.page, pageReads });
	}
	const merged: DocumentPage[] = pages.map((page) => ({ page: page.page, markdown: texts.get(page.page) ?? page.markdown }));
	return { engine: "liteparse", pages: merged, pageCount, pageReads } satisfies Read;
});

/**
 * The batch's pages that this run read already, and the others: copied out of the PDF, then
 * read a few at a time, each kept as soon as it ends. A page that can't be copied is a
 * failed read, and is not kept: it cost nothing.
 */
const readBatch = Effect.fnUntraced(function* (data: Uint8Array, batch: ReadonlyArray<{ page: number; reason: PageReadReason }>, checkpoint: PageCheckpoint) {
	const reader = yield* PageReader.PageReader;
	const todo = batch.filter((page) => !checkpoint.done.has(page.page));
	const copies = todo.length ? yield* Effect.option(onePagePdfs(data, todo.map((page) => page.page))) : Option.some([]);
	const read = Option.isNone(copies)
		? todo.map((page) => notCopied(page.page, page.reason))
		: yield* Effect.forEach(todo, (page, index) => reader.read({ page: page.page, reason: page.reason, pdf: copies.value[index] }).pipe(Effect.tap(checkpoint.save)), {
				concurrency: CALLS_AT_ONCE,
			});
	const byPage = new Map(todo.map((page, index) => [page.page, read[index]]));
	return batch.map((page) => checkpoint.done.get(page.page) ?? byPage.get(page.page)!);
});

const withPdfText = Effect.fnUntraced(function* (data: Uint8Array) {
	yield* Effect.logWarning("workspace documents: LiteParse did not load; reading the PDF's text layer with pdf.js");
	const text = yield* PdfText.PdfText.use((reader) => reader.extract(Buffer.from(data))).pipe(
		Effect.catchTags({ PdfTextError: (error) => Effect.fail(new PdfUnreadable({ reason: "failed", cause: error })) }),
	);
	if (!text) return yield* new PdfUnreadable({ reason: "no-text" });
	const pages = dropRepeatedLines(pdfTextPages(text));
	return { engine: "pdf-text", pages, pageCount: pages.length, pageReads: [] } satisfies Read;
});

/** pdf-text.ts marks each page with "--- Page N ---". */
export function pdfTextPages(text: string): DocumentPage[] {
	const parts = text.split(/^--- Page (\d+) ---$/m);
	const pages: DocumentPage[] = [];
	for (let index = 1; index < parts.length; index += 2) pages.push({ page: Number(parts[index]), markdown: parts[index + 1].trim() });
	return pages;
}

function notCopied(page: number, reason: PageReadReason): PageReader.PageReadResult {
	const record: PageRead = {
		page,
		reason,
		model: PageReader.PAGE_MODEL,
		ok: false,
		error: "The page could not be copied out of the PDF.",
		ms: 0,
		attempts: 0,
		costUsd: null,
		inputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		generationId: null,
		calls: [],
		chars: 0,
	};
	return { record, text: Option.none() };
}

/** A page has text when it has a letter or a digit: marks alone are not text. */
function hasText(markdown: string) {
	return /[\p{L}\p{N}]/u.test(markdown);
}
