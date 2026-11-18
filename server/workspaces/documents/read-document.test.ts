/**
 * Text documents become one Markdown page; a PDF's repeated page headers are dropped.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { dropRepeatedLines } from "./boilerplate.ts";
import { MAX_COLUMNS } from "./csv.ts";
import { headingRule, pdfTextPages, readText as readTextResult } from "./read-document.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const readText = (mediaType: string, data: Uint8Array) => Result.getOrThrow(readTextResult(mediaType, data));
const refusal = (mediaType: string, text: string) => Result.match(readTextResult(mediaType, bytes(text)), { onSuccess: () => null, onFailure: (error) => error });
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

	it("refuses a table that is too wide, or that padding would make too large, before it builds it", () => {
		const wide = refusal("text/csv", `${Array.from({ length: MAX_COLUMNS + 1 }, (_, index) => `c${index}`).join(",")}\n1\n`);
		assert.deepStrictEqual([wide?._tag, wide?.reason], ["TableTooLarge", "columns"]);
		assert.include(wide!.message, "This table is too wide");
		// 4 KB of header over 2 MB of one-cell rows would be about 3 GB of Markdown.
		const header = Array.from({ length: MAX_COLUMNS }, (_, index) => `c${index}`).join(",");
		const ragged = refusal("text/tab-separated-values", `${header.replaceAll(",", "\t")}\n${"1\n".repeat(1_000_000)}`);
		assert.deepStrictEqual([ragged?._tag, ragged?.reason], ["TableTooLarge", "size"]);
		// The same rows under a narrow header are fine.
		assert.strictEqual(refusal("text/csv", `a,b\n${"1\n".repeat(1_000_000)}`), null);
	});

	it("keeps JSON as written when its indents would make it too large", () => {
		const deep = `${"[".repeat(2_000)}${"1,".repeat(1_000_000)}1${"]".repeat(2_000)}`;
		const markdown = readText("application/json", bytes(deep)).pages[0].markdown;
		assert.strictEqual(markdown, `\`\`\`json\n${deep}\n\`\`\``);
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
		// The first page keeps its copy of a line that repeats word for word, in case it is not a footer.
		assert.deepStrictEqual(
			dropRepeatedLines(pages).map((page) => page.markdown),
			TOPICS.map((topic, index) => `Body text about ${topic}.\n| Drug | Dose |${index === 0 ? "\n#### Sundarraj & Dr. Joseph Johny" : ""}`),
		);
	});

	it("keeps lines that differ only in numbers that are not the page's", () => {
		const doses = [5, 10, 15, 20].map((dose, index) => ({ page: index + 1, markdown: `Take ${dose} mg daily.` }));
		assert.deepStrictEqual(dropRepeatedLines(doses), doses);
		const withHeaders = doses.map((page) => ({ ...page, markdown: `Pg. ${page.page} of 4\n${page.markdown}\nPrepared by: QMC` }));
		assert.deepStrictEqual(
			dropRepeatedLines(withHeaders).map((page) => page.markdown),
			doses.map((page, index) => `${page.markdown}${index === 0 ? "\nPrepared by: QMC" : ""}`),
		);
	});

	it("keeps headings and lines whose number follows the page but is not a page number", () => {
		const pages = TOPICS.slice(0, 4).map((topic, index) => ({
			page: index + 1,
			markdown: [`## Case ${index + 1}`, `Notes about ${topic}.`, `Day ${index + 1} of the course: check the dose.`, `Review on day ${index + 1} of care`].join("\n"),
		}));
		assert.deepStrictEqual(dropRepeatedLines(pages), pages);
		// A page number at the edge still goes, in each of its shapes.
		for (const shape of [(page: number) => `Page ${page}`, (page: number) => `Ward notes, ${page} / 4`, (page: number) => `Ward notes - p. ${page}`]) {
			const numbered = pages.map((page) => ({ ...page, markdown: `${page.markdown}\n${shape(page.page)}` }));
			assert.deepStrictEqual(dropRepeatedLines(numbered), pages, shape(1));
		}
	});

	it("keeps the first copy of a line that repeats word for word at the top of each page", () => {
		const pages = [1, 2, 3, 4].map((page) => ({ page, markdown: "Take 5 mg daily." }));
		assert.deepStrictEqual(
			dropRepeatedLines(pages).map((page) => page.markdown),
			["Take 5 mg daily.", "", "", ""],
		);
	});

	it("looks for headers and footers only in the first and last lines of a page", () => {
		const pages = TOPICS.map((topic, index) => ({
			page: index + 1,
			markdown: [`About ${topic}.`, ...Array.from({ length: 4 }, (_, line) => `${topic} line ${line}.`), "Check the exit site daily.", String(index + 1), "- Gauze 10 cm", ...Array.from({ length: 4 }, (_, line) => `${topic} end ${line}.`)].join("\n"),
		}));
		assert.deepStrictEqual(dropRepeatedLines(pages), pages);
	});

	it("splits pdf.js's text into its pages", () => {
		assert.deepStrictEqual(pdfTextPages("--- Page 1 ---\nOne\n\n--- Page 2 ---\nTwo"), [
			{ page: 1, markdown: "One" },
			{ page: 2, markdown: "Two" },
		]);
	});
});
