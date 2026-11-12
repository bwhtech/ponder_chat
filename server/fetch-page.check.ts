/**
 * Checks how web_fetch tidies a page's white space (search/fetch-page.ts): the same text
 * as the pattern it replaced, in time that grows with the length of the page. That pattern
 * took 20 seconds on 160,000 carriage returns, and the server answers nobody meanwhile.
 * Run: npx tsx server/fetch-page.check.ts
 */
import assert from "node:assert/strict";
import { tidy } from "./search/fetch-page.ts";

let failed = 0;

function check(name: string, body: () => void) {
	try {
		body();
		console.log(`ok   ${name}`);
	} catch (error) {
		failed++;
		console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : error}`);
	}
}

/** What tidy was before: right, but slow on a long run of white space with no second line break. */
const before = (text: string) => text.replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*(\n\s*)+/g, "\n\n").trim();

function milliseconds(body: () => void) {
	const start = performance.now();
	body();
	return performance.now() - start;
}

check("spaces become one space and empty lines become one", () => {
	assert.equal(tidy("  Title \t here\n\n\n\nFirst  line\nSecond line \n \n Third\r\n\r\nEnd\n"), "Title here\n\nFirst line\nSecond line\n\nThird\n\nEnd");
	assert.equal(tidy("a  b\r\nc"), "a  b\r\nc");
	assert.equal(tidy(" \n\n "), "");
});

check("gives the same text as the pattern it replaced", () => {
	const pieces = ["a", "b", " ", "  ", "\n", "\n", "\r", "\r\n", "\t", "\f", "\v", " ", " ", " ", "﻿"];
	// A fixed seed, so a failure can be run again.
	let seed = 42;
	const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
	for (let round = 0; round < 20_000; round++) {
		const text = Array.from({ length: next() % 24 }, () => pieces[next() % pieces.length]).join("");
		assert.equal(tidy(text), before(text), JSON.stringify(text));
	}
});

check("a long run of white space takes well under a second", () => {
	for (const space of ["\r", " ", "\n", " \n", "\r\n"]) {
		const text = `a${space.repeat(160_000)}\nb`;
		const took = milliseconds(() => tidy(text));
		assert.ok(took < 200, `160,000 of ${JSON.stringify(space)} took ${took.toFixed(0)} ms`);
	}
	// The most that fetchPage reads.
	const largest = `a${"\r".repeat(3_000_000)}\nb`;
	const took = milliseconds(() => assert.equal(tidy(largest), largest));
	assert.ok(took < 1000, `3,000,000 carriage returns took ${took.toFixed(0)} ms`);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
