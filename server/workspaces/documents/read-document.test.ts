/**
 * Text documents become one Markdown page; a PDF's repeated page headers are dropped.
 */
import { assert, describe, it } from "@effect/vitest";
import { dropRepeatedLines } from "./boilerplate.ts";
import { headingRule, readText } from "./read-document.ts";
import { pdfTextPages } from "./read-pdf.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const TOPICS = ["dialysis", "biopsy", "transplant", "fistula", "peritonitis", "donors"];

describe("readText", () => {
	it("reads a CSV as a Markdown table, with quoted commas, quotes and line breaks kept in their cells", () => {
		const read = readText("text/csv", bytes('drug,dose,note\r\nCefazolin,15 mg/kg,"daily, IP"\r\n"Vanco ""V""",30 mg/kg,"line one\nline two"\r\n'));
		assert.deepStrictEqual(read.pages, [
			{
				page: null,
				markdown: '| drug | dose | note |\n| --- | --- | --- |\n| Cefazolin | 15 mg/kg | daily, IP |\n| Vanco "V" | 30 mg/kg | line one<br>line two |',
			},
		]);
		assert.strictEqual(read.engine, "text");
		assert.strictEqual(read.pageCount, 1);
		assert.deepStrictEqual(read.pageReads, []);
	});

	it("reads a CSV of 300,000 rows", () => {
		const csv = ["drug,dose", ...Array.from({ length: 300_000 }, (_, index) => `${index},1`)].join("\n");
		const lines = readText("text/csv", bytes(csv)).pages[0].markdown.split("\n");
		assert.strictEqual(lines.length, 300_002);
		assert.strictEqual(lines.at(-1), "| 299999 | 1 |");
	});

	it("reads a TSV, and keeps a pipe in a cell from ending it", () => {
		const read = readText("text/tab-separated-values", bytes("a\tb\n1|2\t3\n"));
		assert.strictEqual(read.pages[0].markdown, "| a | b |\n| --- | --- |\n| 1\\|2 | 3 |");
	});

	it("puts JSON in a fence, pretty-printed so it can be split by lines", () => {
		assert.strictEqual(readText("application/json", bytes('{"a":[1,2]}')).pages[0].markdown, '```json\n{\n  "a": [\n    1,\n    2\n  ]\n}\n```');
		assert.strictEqual(readText("application/json", bytes("{not json")).pages[0].markdown, "```json\n{not json\n```");
	});

	it("keeps Markdown and plain text as written, and an empty file has no pages", () => {
		assert.strictEqual(readText("text/markdown", bytes("# Title\r\n\r\nBody\r\n")).pages[0].markdown, "# Title\n\nBody");
		assert.deepStrictEqual(readText("text/plain", bytes("  \n")).pages, []);
		assert.strictEqual(headingRule("text/markdown"), "levels");
		assert.strictEqual(headingRule("application/pdf"), "numbered");
	});
});

describe("dropRepeatedLines", () => {
	it("drops header and footer lines that repeat with other numbers or spacing, and the page's own number", () => {
		const pages = Array.from({ length: 6 }, (_, index) => ({
			page: index + 1,
			markdown: [
				index % 2 ? `**MAN/RPT/001 Ver.: 1 Issue :1** Pg. ${index + 1} of 6` : `**MAN/RPT/001 Ver.: 1 Issue: 1** Pg. ${index + 1} of 6`,
				`Body text about ${TOPICS[index]}.`,
				"| Drug | Dose |",
				String(index + 1),
				"---",
				"#### Sundarraj & Dr. Joseph Johny",
			].join("\n"),
		}));
		assert.deepStrictEqual(
			dropRepeatedLines(pages).map((page) => page.markdown),
			TOPICS.map((topic) => `Body text about ${topic}.\n| Drug | Dose |`),
		);
	});

	it("splits pdf.js's text into its pages", () => {
		assert.deepStrictEqual(pdfTextPages("--- Page 1 ---\nOne\n\n--- Page 2 ---\nTwo"), [
			{ page: 1, markdown: "One" },
			{ page: 2, markdown: "Two" },
		]);
	});
});
