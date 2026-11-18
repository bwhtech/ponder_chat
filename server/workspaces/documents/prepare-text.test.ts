/**
 * Reading and splitting in the worker thread (prepare-text.ts): it gives what the pure
 * functions give, and a job that takes too long or too much memory is stopped and fails
 * with its reason. Real workers, on the real clock (it.live).
 */
import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { chunkDocument } from "./chunk.ts";
import { MAX_PASSAGE_CHARS, MAX_TEXT_CHARS } from "./limits.ts";
import * as PrepareText from "./prepare-text.ts";
import { headingRule, readText, storedPages, storedText } from "./read-document.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const CSV = ["drug,dose,note", ...Array.from({ length: 400 }, (_, index) => `Drug ${index},${index} mg/kg,"daily, IP"`)].join("\n");
/** About 10 MB of short rows: the worst CSV the size limits let through, about 2.5 seconds of work. */
const LARGE_CSV = ["drug,dose", ...Array.from({ length: 1_200_000 }, (_, index) => `${index},1`)].join("\n");

const FIXTURE = new Uint8Array(readFileSync(new URL("./fixtures/picture-pages.pdf", import.meta.url)));

const prepare = <A, E>(use: (service: PrepareText.PrepareText["Service"]) => Effect.Effect<A, E>, limits?: Partial<PrepareText.Limits>) =>
	PrepareText.PrepareText.use(use).pipe(Effect.provide(limits ? PrepareText.layerWith(limits) : PrepareText.layer));

describe("PrepareText", () => {
	it.live("reads a CSV and splits it in a worker, as the pure functions do", () =>
		Effect.gen(function* () {
			const read = yield* prepare((service) => service.read({ name: "Doses", mediaType: "text/csv", data: bytes(CSV) }));
			const direct = Result.getOrThrow(readText("text/csv", bytes(CSV)));
			const text = storedText(direct.pages);
			assert.strictEqual(read.text, text);
			assert.deepStrictEqual(read.passages, chunkDocument({ name: "Doses", pages: storedPages("text/csv", text), headings: headingRule("text/csv") }));
			assert.isAbove(read.passages.length, 1);
			assert.deepStrictEqual({ ...read.read, ms: 0 }, { engine: "text", pageCount: 1, chars: direct.chars, ms: 0, pageReads: [] });
		}),
	);

	it.live("splits a PDF's stored text by its pages", () =>
		Effect.gen(function* () {
			const text = "--- Page 1 ---\n# Dialysis\n\nCheck the exit site daily.\n\n--- Page 2 ---\n## Peritonitis\n\nGive cefazolin.";
			const passages = yield* prepare((service) => service.chunk({ name: "Manual", mediaType: "application/pdf", text }));
			assert.deepStrictEqual(passages, chunkDocument({ name: "Manual", pages: storedPages("application/pdf", text), headings: "numbered" }));
			assert.strictEqual(passages[0].page, 1);
		}),
	);

	it.live("does not repeat a header too long to repeat: a 54 KB CSV makes a few passages, not 100 million characters", () =>
		Effect.gen(function* () {
			const csv = `${"h".repeat(50_000)}\n${"1\n".repeat(2_000)}`;
			const read = yield* prepare((service) => service.read({ name: "Long header", mediaType: "text/csv", data: bytes(csv) }));
			const chars = read.passages.reduce((sum, passage) => sum + passage.content.length, 0);
			assert.isBelow(chars, 2 * read.text.length);
			assert.isBelow(read.passages.length, 100);
			assert.isAtMost(Math.max(...read.passages.map((passage) => passage.content.length)), MAX_PASSAGE_CHARS);
			// The header once, then its rows as lines.
			assert.strictEqual(read.passages.reduce((sum, passage) => sum + passage.content.split("h").length - 1, 0), 50_000);
			assert.include(read.passages.at(-1)!.content, "| 1 |\n| 1 |");
		}),
	);

	it.live("refuses a document that would make too many passages, before it makes them all", () =>
		Effect.gen(function* () {
			// A header of 1,900 characters fits in a passage with one row only: 30,000 rows, 30,000 passages.
			const csv = `${"h".repeat(1_900)}\n${"1\n".repeat(30_000)}`;
			const error = yield* Effect.flip(prepare((service) => service.read({ name: "Many rows", mediaType: "text/csv", data: bytes(csv) })));
			assert.deepStrictEqual([error._tag, error.message], ["DocumentTooLarge", "The document is too large to read: it makes too many passages. Split it into smaller files."]);
		}),
	);

	it.live("refuses a stored text that is too long", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(prepare((service) => service.chunk({ name: "Long", mediaType: "text/plain", text: "a".repeat(MAX_TEXT_CHARS + 1) })));
			assert.deepStrictEqual([error._tag, error._tag === "DocumentTooLarge" && error.reason], ["DocumentTooLarge", "text"]);
		}),
	);

	it.live("reads a PDF's pages in the worker: the Markdown of each, and the pages a model must read", () =>
		Effect.gen(function* () {
			const parsed = yield* prepare((service) => service.parsePdf(FIXTURE));
			assert.deepStrictEqual([parsed.engine, parsed.pageCount], ["liteparse", 3]);
			assert.deepStrictEqual(
				parsed.pages.map((page) => [page.page, page.modelReason]),
				[
					[1, null],
					[2, "picture"],
					[3, "scan"],
				],
			);
			assert.include(parsed.pages[0].markdown, "Peritonitis is the main infection of peritoneal dialysis.");
		}),
	);

	it.live("refuses what is not a PDF as unreadable", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(prepare((service) => service.parsePdf(bytes("%PDF-1.7\nnothing more"))));
			assert.deepStrictEqual([error._tag, error.message], ["PdfUnreadable", "The PDF could not be read."]);
		}),
	);

	it.live("makes a PDF's stored text and passages from its pages, and refuses pages with too much text", () =>
		Effect.gen(function* () {
			const pages = [
				{ page: 1, markdown: "# Dialysis\n\nCheck the exit site daily." },
				{ page: 2, markdown: "## Peritonitis\n\nGive cefazolin." },
			];
			const prepared = yield* prepare((service) => service.preparePdf({ name: "Manual", pages }));
			assert.strictEqual(prepared.text, storedText(pages));
			assert.deepStrictEqual(prepared.passages, chunkDocument({ name: "Manual", pages: storedPages("application/pdf", prepared.text), headings: "numbered" }));
			const long = Array.from({ length: 3 }, (_, index) => ({ page: index + 1, markdown: "a".repeat(MAX_TEXT_CHARS / 2) }));
			const error = yield* Effect.flip(prepare((service) => service.preparePdf({ name: "Long", pages: long })));
			assert.deepStrictEqual([error._tag, error._tag === "DocumentTooLarge" && error.reason], ["DocumentTooLarge", "text"]);
		}),
	);

	it.live("refuses a table that is too wide with the table's own reason", () =>
		Effect.gen(function* () {
			const wide = `${Array.from({ length: 501 }, (_, index) => `c${index}`).join(",")}\n1\n`;
			const error = yield* Effect.flip(prepare((service) => service.read({ name: "Wide", mediaType: "text/csv", data: bytes(wide) })));
			assert.strictEqual(error._tag, "TableTooLarge");
			assert.strictEqual(error.message, "This table is too wide. It can have at most 500 columns.");
		}),
	);

	it.live("stops a job that takes too long: the worker no longer runs once the error is back", () =>
		Effect.gen(function* () {
			const started = performance.now();
			const error = yield* Effect.flip(prepare((service) => service.read({ name: "Large", mediaType: "text/csv", data: bytes(LARGE_CSV) }), { timeout: "300 millis", maxHeapMb: 512 }));
			assert.strictEqual(error._tag, "PrepareTextError");
			assert.deepStrictEqual([error._tag === "PrepareTextError" && error.reason, error.message], ["timeout", "Reading the document timed out after 0.3 seconds."]);
			assert.isBelow(performance.now() - started, 1_500);
			// A worker's CPU time counts in the process's. A worker still at work would add about as much as the wait.
			const cpu = process.cpuUsage();
			yield* Effect.sleep("500 millis");
			assert.isBelow(process.cpuUsage(cpu).user / 1_000, 200);
		}),
	);

	it.live("stops a job that runs out of memory, and says the document is too large to read", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(prepare((service) => service.read({ name: "Large", mediaType: "text/csv", data: bytes(LARGE_CSV) }), { timeout: "30 seconds", maxHeapMb: 32 }));
			assert.deepStrictEqual([error._tag === "PrepareTextError" && error.reason, error.message], ["memory", "The document is too large or complex to read."]);
		}),
	);
});
