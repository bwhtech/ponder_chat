/**
 * The PDF reader on a small PDF made for it (fixtures/make-fixture.ts): a text page, a
 * page with a picture of a table, and a scan. The model is a fake that answers in the test.
 */
import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PdfText from "../../pdf-text.ts";
import type { PageRead } from "./document.ts";
import * as PageReader from "./page-reader.ts";
import { NO_CHECKPOINT, readPdf } from "./read-pdf.ts";

const FIXTURE = new Uint8Array(readFileSync(new URL("./fixtures/picture-pages.pdf", import.meta.url)));
const TABLE = "| Drug | Intermittent (daily) |\n| --- | --- |\n| Cefazolin | 15 mg/kg daily |";
const SCAN = "Exit site care: clean the exit site every second day.";

/** A fake model: the text for each page, or a failure; and the pages it was asked for, with the PDFs it got. */
function fakeModel(answers: Record<number, string | "fail">) {
	const asked: { page: number; reason: string; pdf: Uint8Array }[] = [];
	const read = (request: PageReader.PageRequest) =>
		Effect.sync((): PageReader.PageReadResult => {
			asked.push(request);
			const answer = answers[request.page];
			const ok = answer !== undefined && answer !== "fail";
			const record: PageRead = {
				page: request.page,
				reason: request.reason,
				model: PageReader.PAGE_MODEL,
				ok,
				error: ok ? null : "Provider returned error",
				ms: 5,
				attempts: 1,
				costUsd: ok ? 0.002 : null,
				inputTokens: 1_200,
				outputTokens: ok ? 80 : 0,
				reasoningTokens: 0,
				generationId: ok ? `gen-${request.page}` : null,
				calls: ok ? [{ generationId: `gen-${request.page}`, costUsd: 0.002, inputTokens: 1_200, outputTokens: 80 }] : [],
				chars: ok ? answer.length : 0,
			};
			return { record, text: ok ? Option.some(answer) : Option.none() };
		});
	const layer = Layer.mergeAll(Layer.succeed(PageReader.PageReader, PageReader.PageReader.of({ read })), PdfText.layer);
	return { asked, layer };
}

describe("readPdf", () => {
	it.effect("sends the picture page and the scan to the model, and uses its text for them", () => {
		const model = fakeModel({ 2: TABLE, 3: SCAN });
		return Effect.gen(function* () {
			const read = yield* readPdf(FIXTURE);
			assert.strictEqual(read.engine, "liteparse");
			assert.strictEqual(read.pageCount, 3);
			assert.deepStrictEqual(
				model.asked.map(({ page, reason }) => ({ page, reason })),
				[
					{ page: 2, reason: "picture" },
					{ page: 3, reason: "scan" },
				],
			);
			// Each call gets a PDF of one page.
			for (const { pdf } of model.asked) assert.strictEqual(Buffer.from(pdf.subarray(0, 5)).toString(), "%PDF-");
			assert.deepStrictEqual(
				read.pages.map((page) => page.page),
				[1, 2, 3],
			);
			assert.include(read.pages[0].markdown, "Peritonitis is the main infection of peritoneal dialysis.");
			assert.strictEqual(read.pages[1].markdown, TABLE);
			assert.strictEqual(read.pages[2].markdown, SCAN);
			assert.strictEqual(read.chars, read.pages.reduce((sum, page) => sum + page.markdown.length, 0));
			assert.deepStrictEqual(
				read.pageReads.map((page) => [page.page, page.ok, page.generationId]),
				[
					[2, true, "gen-2"],
					[3, true, "gen-3"],
				],
			);
		}).pipe(Effect.provide(model.layer));
	});

	it.effect("fails the read with the page number when a page with no text can't be read", () => {
		const model = fakeModel({ 2: TABLE, 3: "fail" });
		return Effect.gen(function* () {
			const error = yield* Effect.flip(readPdf(FIXTURE));
			assert.strictEqual(error._tag, "PageUnreadable");
			if (error._tag !== "PageUnreadable") return;
			assert.strictEqual(error.page, 3);
			assert.strictEqual(error.message, "Page 3 has no text, and the model could not read it.");
			// The calls made are in the error, for the log.
			assert.deepStrictEqual(
				error.pageReads.map((page) => [page.page, page.ok]),
				[
					[2, true],
					[3, false],
				],
			);
		}).pipe(Effect.provide(model.layer));
	});

	it.effect("uses the pages this run read already, and keeps each new one as soon as it is read", () => {
		const earlier = fakeModel({ 2: TABLE });
		const model = fakeModel({ 2: "fail", 3: SCAN });
		const saved: number[] = [];
		return Effect.gen(function* () {
			const page2 = yield* earlier.layer.pipe(Layer.build, Effect.flatMap((context) => PageReader.PageReader.use((reader) => reader.read({ page: 2, reason: "picture", pdf: FIXTURE })).pipe(Effect.provideContext(context))), Effect.scoped);
			const checkpoint = { ...NO_CHECKPOINT, done: new Map([[2, page2]]), save: (result: PageReader.PageReadResult) => Effect.sync(() => void saved.push(result.record.page)) };
			const read = yield* readPdf(FIXTURE, checkpoint);
			assert.deepStrictEqual(
				model.asked.map(({ page }) => page),
				[3],
			);
			assert.deepStrictEqual(saved, [3]);
			assert.strictEqual(read.pages[1].markdown, TABLE);
			assert.deepStrictEqual(
				read.pageReads.map((page) => [page.page, page.ok]),
				[
					[2, true],
					[3, true],
				],
			);
		}).pipe(Effect.provide(model.layer));
	});

	it.effect("stops before it pays for a page once the run is no longer wanted", () => {
		const model = fakeModel({ 2: TABLE, 3: SCAN });
		return Effect.gen(function* () {
			const error = yield* Effect.flip(readPdf(FIXTURE, { ...NO_CHECKPOINT, live: Effect.succeed(false) }));
			assert.strictEqual(error._tag, "ReadStopped");
			assert.deepStrictEqual(model.asked, []);
		}).pipe(Effect.provide(model.layer));
	});

	it.effect("keeps LiteParse's text of a picture page whose call fails, and records the failure", () => {
		const model = fakeModel({ 2: "fail", 3: SCAN });
		return Effect.gen(function* () {
			const read = yield* readPdf(FIXTURE);
			assert.include(read.pages[1].markdown, "Doses for peritonitis");
			const failed = read.pageReads.find((page) => page.page === 2);
			assert.strictEqual(failed?.ok, false);
			assert.strictEqual(failed?.error, "Provider returned error");
		}).pipe(Effect.provide(model.layer));
	});

	it.effect("keeps no page text in the records of the model calls", () => {
		const model = fakeModel({ 2: TABLE, 3: SCAN });
		return Effect.gen(function* () {
			const read = yield* readPdf(FIXTURE);
			const records = JSON.stringify(read.pageReads);
			for (const text of [TABLE, SCAN, "Cefazolin", "Exit site", "Doses for peritonitis", "Peritonitis is the main"]) assert.notInclude(records, text);
			assert.deepStrictEqual(Object.keys(read.pageReads[0]).sort(), [
				"attempts",
				"calls",
				"chars",
				"costUsd",
				"error",
				"generationId",
				"inputTokens",
				"model",
				"ms",
				"ok",
				"outputTokens",
				"page",
				"reason",
				"reasoningTokens",
			]);
		}).pipe(Effect.provide(model.layer));
	});
});
