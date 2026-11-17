/**
 * Reads the test PDF (fixtures/picture-pages.pdf) with the real model: its page with a
 * picture of a dose table, and its scan. Checks that the model's text has every dose of
 * the table and the scan's words, and that each call has a cost and a generation id.
 * Costs about $0.004.
 * Run: set -a; . ~/.config/ponder-chat/.env; set +a; npx tsx server/workspaces/documents/read-pdf.check.ts --live
 * Without --live it does nothing: the unit tests cover the reader with a fake model.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { liveLayer } from "../eval/layers.ts";
import { PageUnreadable, readPdf } from "./read-pdf.ts";

if (!process.argv.includes("--live")) {
	console.log("skip read-pdf.check.ts: pass --live to call the model");
	process.exit(0);
}

const FIXTURE = new Uint8Array(readFileSync(new URL("./fixtures/picture-pages.pdf", import.meta.url)));
const runtime = ManagedRuntime.make(liveLayer);
let failed = 0;

try {
	const read = await runtime.runPromise(readPdf(FIXTURE));
	const [, picture, scan] = read.pages;
	const check = (name: string, body: () => void) => {
		try {
			body();
			console.log(`ok   ${name}`);
		} catch (error) {
			failed++;
			console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : error}`);
		}
	};
	check("the picture page and the scan went to the model, and both were read", () => {
		assert.deepEqual(
			read.pageReads.map((page) => [page.page, page.reason, page.ok]),
			[
				[2, "picture", true],
				[3, "scan", true],
			],
		);
	});
	check("the table's drugs and doses are in the picture page's text, as a Markdown table", () => {
		for (const cell of ["Cefazolin", "15 mg/kg daily", "LD 500 mg/L", "Gentamicin", "0.6 mg/kg daily", "LD 8 mg/L", "Vancomycin", "30 mg/kg every 5 days", "LD 30 mg/kg"]) assert.ok(picture.markdown.includes(cell), `no "${cell}" in:\n${picture.markdown}`);
		assert.match(picture.markdown, /^\|.*Cefazolin.*\|$/m);
	});
	check("the scan's words are in its text", () => {
		for (const words of ["Exit site care", "every second day", "sterile gauze and saline"]) assert.ok(scan.markdown.includes(words), `no "${words}" in:\n${scan.markdown}`);
	});
	check("each call has a cost, tokens and a generation id", () => {
		for (const page of read.pageReads) {
			assert.ok((page.costUsd ?? 0) > 0, `page ${page.page}: no cost`);
			assert.ok(page.inputTokens > 0 && page.outputTokens > 0, `page ${page.page}: no tokens`);
			assert.match(page.generationId ?? "", /^gen-/);
		}
	});
	const cost = read.pageReads.reduce((sum, page) => sum + (page.costUsd ?? 0), 0);
	console.log(`     ${read.pageReads.length} pages, $${cost.toFixed(5)}, ${read.ms} ms (${read.pageReads.map((page) => `page ${page.page}: ${page.ms} ms`).join(", ")})`);
	console.log(`\n--- page 2 ---\n${picture.markdown}\n--- page 3 ---\n${scan.markdown}`);
} catch (error) {
	failed++;
	console.log(`FAIL reading the PDF\n     ${error instanceof Error ? error.message : error}`);
	if (error instanceof PageUnreadable) for (const page of error.pageReads) console.log(`     page ${page.page}: ${page.ok ? "read" : page.error}`);
} finally {
	await runtime.dispose();
}

process.exit(failed ? 1 : 0);
