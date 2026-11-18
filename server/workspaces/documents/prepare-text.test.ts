/**
 * Reading and splitting in the worker thread (prepare-text.ts): it gives what the pure
 * functions give, and a job that takes too long or too much memory is stopped and fails
 * with its reason. Real workers, on the real clock (it.live).
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { chunkDocument } from "./chunk.ts";
import * as PrepareText from "./prepare-text.ts";
import { headingRule, readText, storedPages, storedText } from "./read-document.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const CSV = ["drug,dose,note", ...Array.from({ length: 400 }, (_, index) => `Drug ${index},${index} mg/kg,"daily, IP"`)].join("\n");
/** About 10 MB of short rows: the worst CSV the size limits let through, about 2.5 seconds of work. */
const LARGE_CSV = ["drug,dose", ...Array.from({ length: 1_200_000 }, (_, index) => `${index},1`)].join("\n");

const prepare = <A, E>(use: (service: PrepareText.PrepareText["Service"]) => Effect.Effect<A, E>, limits?: PrepareText.Limits) =>
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
