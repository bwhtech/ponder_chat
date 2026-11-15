/**
 * Checks how a PDF's text is read (pdf-text.ts): the text of a usual PDF, "" for a scan,
 * and a PDF made to take months is stopped while this thread keeps running.
 * Run: npx tsx server/pdf-text.check.ts
 */
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { pagesPdf, slowPdf, textPdf } from "../e2e/pdfs.ts";
import * as PdfText from "./pdf-text.ts";

// The service on a runtime of its own: one set of reading slots for every check.
const runtime = ManagedRuntime.make(PdfText.layer);
const extractPdfText = (data: Buffer, timeoutMs?: number) =>
	runtime.runPromise(PdfText.PdfText.use((pdf) => pdf.extract(data, timeoutMs)));

let failed = 0;

async function check(name: string, body: () => Promise<void>) {
	try {
		await body();
		console.log(`ok   ${name}`);
	} catch (error) {
		failed++;
		console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : error}`);
	}
}

const FIRST = "The quick brown fox jumps over the lazy dog, twice.";
const SECOND = "Pack my box with five dozen liquor jugs, and then rest.";
const SLOW = slowPdf();

await check("reads the text of each page", async () => {
	assert.equal(await extractPdfText(textPdf([FIRST, SECOND])), `--- Page 1 ---\n${FIRST}\n\n--- Page 2 ---\n${SECOND}`);
});

await check("a PDF with little or no text gives no text", async () => {
	assert.equal(await extractPdfText(pagesPdf(["0 0 100 100 re f"])), "");
	assert.equal(await extractPdfText(textPdf(["Page 1"])), "");
});

await check("what is not a PDF fails", async () => {
	await assert.rejects(extractPdfText(Buffer.from("%PDF-1.7\nnothing more")));
});

await check("a PDF that takes too long is stopped, and this thread keeps running", async () => {
	let ticks = 0;
	const ticking = setInterval(() => ticks++, 5);
	const start = performance.now();
	await assert.rejects(extractPdfText(SLOW, 1000), /took longer than 1 seconds/);
	clearInterval(ticking);
	const took = performance.now() - start;
	assert.ok(took < 2000, `stopped after ${took.toFixed(0)} ms`);
	// On the server's own thread, pdf.js let no timer run at all.
	assert.ok(ticks > 100, `only ${ticks} timer ticks in ${took.toFixed(0)} ms`);
});

await check("two PDFs are read at once, and the others wait", async () => {
	const start = performance.now();
	const ends = await Promise.all(Array.from({ length: 6 }, () => extractPdfText(SLOW, 500).catch(() => performance.now() - start)));
	// Three pairs, each stopped after half a second.
	assert.deepEqual(ends.map((end) => Math.round(Number(end) / 500)), [1, 1, 2, 2, 3, 3]);
});

await check("a usual PDF is still read after the slow ones", async () => {
	assert.match(await extractPdfText(textPdf([FIRST])), /quick brown fox/);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
