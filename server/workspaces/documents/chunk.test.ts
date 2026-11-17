/**
 * The chunker: passages split by structure, with a location line, and tables split by
 * rows with their header repeated.
 */
import { assert, describe, it } from "@effect/vitest";
import { chunkDocument, embeddingText, MAX, MAX_ROW, TARGET, type Passage } from "./chunk.ts";
import type { DocumentPage } from "./document.ts";
import { readText } from "./read-document.ts";

const HEADER = "| Drug | Intermittent | Continuous |\n| --- | --- | --- |";
const row = (index: number) => `| Drug ${index} | ${index} mg/kg daily | LD ${index * 10} mg/L, MD ${index * 2} mg/L, given in every exchange |`;
const table = (rows: number) => [HEADER, ...Array.from({ length: rows }, (_, index) => row(index + 1))].join("\n");
const paragraph = (words: number, seed = "dialysis") => Array.from({ length: words }, (_, index) => `${seed}${index % 7}`).join(" ") + ".";

const tableRows = (passage: Passage) => passage.content.split("\n").filter((line) => /^\| Drug \d/.test(line));

describe("chunkDocument", () => {
	it("splits a long table by rows, never inside a row, and repeats its header in each part", () => {
		const rows = 60;
		const passages = chunkDocument({ name: "Manual", pages: [{ page: 251, markdown: `#### Doses\n\n${table(rows)}` }], headings: "numbered" });
		assert.isAbove(passages.length, 2);
		const seen: string[] = [];
		for (const passage of passages) {
			// The first part is under the heading.
			assert.isTrue(passage.content.replace(/^#### Doses\n\n/, "").startsWith(HEADER), `part ${passage.ordinal} has no header`);
			assert.strictEqual(passage.location, "Manual › Doses (page 251)");
			for (const line of tableRows(passage)) {
				assert.match(line, /^\| Drug \d+ \| .* \|$/);
				seen.push(line);
			}
		}
		assert.deepStrictEqual(seen, Array.from({ length: rows }, (_, index) => row(index + 1)));
	});

	it("keeps a table up to MAX whole, even past TARGET", () => {
		const whole = table(14);
		assert.isAbove(whole.length, TARGET);
		assert.isAtMost(whole.length, MAX);
		const passages = chunkDocument({ name: "Manual", pages: [{ page: 3, markdown: `${paragraph(150)}\n\n${whole}` }], headings: "numbered" });
		assert.strictEqual(passages.filter((passage) => passage.content.includes(HEADER)).length, 1);
		assert.isTrue(passages.some((passage) => passage.content.endsWith(whole)));
	});

	it("gives each passage a location line with its heading path and page", () => {
		const pages = [
			{ page: 249, markdown: `#### 13. PERITONEAL DIALYSIS\n\n${paragraph(150)}\n\n#### 13.4 Peritonitis\n\n${paragraph(150, "cloudy")}` },
			{ page: 250, markdown: `#### Treatment\n\n${paragraph(150, "antibiotic")}\n\n#### 14. TRANSPLANT\n\n${paragraph(150, "donor")}` },
		];
		const passages = chunkDocument({ name: "Nephrology manual", pages, headings: "numbered" });
		const where = (word: string) => passages.find((passage) => passage.content.includes(word))?.location;
		assert.strictEqual(where("dialysis0"), "Nephrology manual › 13. PERITONEAL DIALYSIS (page 249)");
		assert.strictEqual(where("cloudy0"), "Nephrology manual › 13. PERITONEAL DIALYSIS › 13.4 Peritonitis (page 249)");
		assert.strictEqual(where("antibiotic0"), "Nephrology manual › 13. PERITONEAL DIALYSIS › 13.4 Peritonitis › Treatment (page 250)");
		assert.strictEqual(where("donor0"), "Nephrology manual › 14. TRANSPLANT (page 250)");
		for (const passage of passages) assert.strictEqual(embeddingText(passage), `${passage.location}\n${passage.content}`);
		assert.deepStrictEqual(
			passages.map((passage) => passage.ordinal),
			passages.map((_, index) => index),
		);
	});

	it("carries headings across pages, and a passage that spans pages takes its first page", () => {
		const pages = [
			{ page: 10, markdown: `#### 2. Exit site care\n\n${paragraph(20, "gauze")}` },
			{ page: 11, markdown: paragraph(20, "saline") },
			{ page: 12, markdown: `${paragraph(150, "dressing")}` },
		];
		const passages = chunkDocument({ name: "Manual", pages, headings: "numbered" });
		const first = passages.find((passage) => passage.content.includes("gauze0"));
		assert.strictEqual(first?.page, 10);
		assert.include(first?.content, "saline0");
		const later = passages.find((passage) => passage.content.includes("dressing0"));
		assert.strictEqual(later?.page, 12);
		assert.strictEqual(later?.location, "Manual › 2. Exit site care (page 12)");
	});

	it("starts a passage at each heading, and joins a small section to the next", () => {
		const markdown = `#### Materials required\n\n- Syringe\n- Gauze\n\n#### Method\n\n${paragraph(150, "wash")}\n\n#### Disposal\n\n${paragraph(150, "bin")}`;
		const passages = chunkDocument({ name: "Manual", pages: [{ page: 1, markdown }], headings: "numbered" });
		assert.isTrue(passages[0].content.startsWith("#### Materials required\n\n- Syringe\n- Gauze\n\n#### Method"));
		const disposal = passages.find((passage) => passage.content.includes("#### Disposal"));
		assert.isTrue(disposal?.content.startsWith("#### Disposal"));
		assert.isFalse(passages.some((passage) => passage.content.includes("wash0") && passage.content.includes("bin0")));
	});

	it("keeps every passage within MAX, and near TARGET for plain text", () => {
		const long = Array.from({ length: 40 }, (_, index) => `Sentence ${index} ${paragraph(30)}`).join(" ");
		const markdown = `# Guide\n\n${long}\n\n${table(80)}\n\n${"x".repeat(5_000)}`;
		const passages = chunkDocument({ name: "Guide", pages: [{ page: null, markdown }], headings: "levels" });
		for (const passage of passages) assert.isAtMost(passage.content.length, MAX, `passage ${passage.ordinal}`);
		const prose = passages.filter((passage) => passage.content.includes("Sentence"));
		for (const passage of prose) assert.isAtMost(passage.content.length, TARGET + 300);
	});

	it("follows Markdown levels in a Markdown file", () => {
		const markdown = `# Guide\n\n## Setup\n\n### Install\n\n${paragraph(150)}\n\n## Use\n\n${paragraph(150, "run")}`;
		const passages = chunkDocument({ name: "Readme", pages: [{ page: null, markdown }], headings: "levels" });
		assert.strictEqual(passages[0].location, "Readme › Guide › Setup › Install");
		assert.strictEqual(passages.find((passage) => passage.content.includes("run0"))?.location, "Readme › Guide › Use");
	});

	it("turns a CSV into table rows, with the header in each passage", () => {
		const csv = ["name,dose,notes", ...Array.from({ length: 80 }, (_, index) => `Drug ${index},${index} mg,"given daily, with food"`)].join("\n");
		const read = readText("text/csv", new TextEncoder().encode(csv));
		const passages = chunkDocument({ name: "Doses", pages: read.pages, headings: "levels" });
		assert.isAbove(passages.length, 1);
		for (const passage of passages) {
			assert.isTrue(passage.content.startsWith("| name | dose | notes |\n| --- | --- | --- |"));
			assert.strictEqual(passage.location, "Doses");
		}
		const rows = passages.flatMap((passage) => passage.content.split("\n").slice(2));
		assert.strictEqual(rows.length, 80);
		assert.strictEqual(rows[0], "| Drug 0 | 0 mg | given daily, with food |");
	});

	it("never cuts a long row: it keeps its header, past MAX if it must", () => {
		const long = `| Cefazolin | ${"15 mg/kg daily, ".repeat(200)}|`;
		assert.isAbove(HEADER.length + long.length, MAX);
		const markdown = [HEADER, row(1), long, row(2)].join("\n");
		const passages = chunkDocument({ name: "Manual", pages: [{ page: 251, markdown }], headings: "numbered" });
		const holding = passages.filter((passage) => passage.content.includes("| Cefazolin |"));
		assert.strictEqual(holding.length, 1);
		assert.strictEqual(holding[0].content, `${HEADER}\n${long}`);
		assert.deepStrictEqual(passages.flatMap(tableRows), [row(1), row(2)]);
	});

	it("cuts a row only past MAX_ROW, and repeats the header in each piece", () => {
		const cells = Array.from({ length: 1_500 }, (_, index) => `dose${index}`).join(" ");
		const long = `| Vancomycin | ${cells} |`;
		assert.isAbove(long.length, MAX_ROW);
		const passages = chunkDocument({ name: "Manual", pages: [{ page: 252, markdown: `${HEADER}\n${long}` }], headings: "numbered" });
		assert.isAbove(passages.length, 1);
		for (const passage of passages) assert.isTrue(passage.content.startsWith(`${HEADER}\n`), `part ${passage.ordinal} has no header`);
		const pieces = passages.map((passage) => passage.content.slice(HEADER.length + 1));
		assert.strictEqual(pieces.join(" "), long);
	});

	it("reads a pipe line with no separator line as text, and keeps a table that has only its header", () => {
		const alone = chunkDocument({ name: "Manual", pages: [{ page: 7, markdown: "Cefazolin dose:\n\n| Cefazolin | 15 mg/kg daily |" }], headings: "numbered" });
		assert.include(alone.map((passage) => passage.content).join("\n"), "| Cefazolin | 15 mg/kg daily |");
		const headerOnly = chunkDocument({ name: "Manual", pages: [{ page: 8, markdown: HEADER }], headings: "numbered" });
		assert.include(headerOnly.map((passage) => passage.content).join("\n"), HEADER);
	});

	it("drops rows of empty cells, so a page of text that LiteParse took for a table header is split as text", () => {
		const text = Array.from({ length: 60 }, (_, index) => `Check the exit site ${index}.`).join(" ");
		const markdown = [`| ${text} |`, "|---|---|", "|  |  |", "|  |  |", "|  |  |"].join("\n");
		const passages = chunkDocument({ name: "Manual", pages: [{ page: 264, markdown }], headings: "numbered" });
		assert.isAbove(passages.length, 1);
		for (const passage of passages) assert.isAtMost(passage.content.length, TARGET);
		assert.include(squash(passages.map((passage) => passage.content).join("\n")), squash(text));
		assert.notInclude(passages.map((passage) => passage.content).join("\n"), "|  |  |");
	});

	it("keeps every line of the input in some passage, but rows of empty cells", () => {
		for (let seed = 1; seed <= 60; seed++) {
			const pages = randomPages(seed);
			for (const headings of ["numbered", "levels"] as const) {
				const passages = chunkDocument({ name: "Doc", pages, headings });
				const all = squash(passages.map((passage) => passage.content).join("\n"));
				for (const page of pages) {
					for (const line of page.markdown.split("\n").filter((one) => !/^[\s|]*$/.test(one))) {
						assert.include(all, squash(line), `seed ${seed}, ${headings}: lost ${JSON.stringify(line.slice(0, 80))}`);
					}
				}
			}
		}
	});

	it("is deterministic", () => {
		const pages = [{ page: 1, markdown: `#### 1. A\n\n${paragraph(400)}\n\n${table(50)}` }];
		assert.deepStrictEqual(chunkDocument({ name: "D", pages, headings: "numbered" }), chunkDocument({ name: "D", pages, headings: "numbered" }));
	});
});

/** Without spaces and line breaks: the chunker may cut a long line at a space, and joins pieces with a line break. */
function squash(text: string) {
	return text.replace(/\s+/g, "");
}

/** A few pages of mixed Markdown, the same for the same seed. */
function randomPages(seed: number): DocumentPage[] {
	const random = seeded(seed);
	const pick = <T>(items: ReadonlyArray<T>) => items[Math.floor(random() * items.length)];
	const count = (most: number) => 1 + Math.floor(random() * most);
	const words = (many: number) => Array.from({ length: many }, () => pick(["dose", "mg/kg", "daily", "10", "Cefazolin", "exit", "site", "|", "-", "#", "**bold**", "2.3"])).join(" ");
	const blocks: Array<() => string> = [
		() => `${"#".repeat(count(4))} ${pick(["", "2.", "2.3", "13.4.1"])} ${words(count(6))}`,
		() => `**${words(3)}**`,
		() => `#### ${words(40)}`,
		() => `${words(count(400))}.`,
		() => Array.from({ length: count(6) }, () => `- ${words(4)}`).join("\n"),
		() => Array.from({ length: 1 + count(30) }, (_, index) => (index === 1 ? "| --- | --- |" : `| ${words(2)} | ${words(count(40))} |`)).join("\n"),
		() => `| ${words(2)} | ${words(3)} |`,
		() => Array.from({ length: 1 + count(4) }, () => `| ${words(2)} | ${words(2)} |`).join("\n"),
		() => "| Drug | Dose |\n| --- | --- |",
		() => `| ${words(count(600))} |\n|---|---|\n|  |  |\n|  |  |`,
		() => `| Drug | ${pick(["Taken", "Change"])} |\n| --- | --- |\n| ✓ | ✗ |\n| + | − |\n| — | ${pick(["-", "%", "→"])} |`,
		() => `| Long | ${words(700)} |`,
		() => "```\nconst dose = 10;\n\n| not a table |\n```",
		() => "Text then a pipe line\n| A | B |\nand more text",
		() => "",
	];
	return Array.from({ length: count(4) }, (_, index) => ({
		page: index + 1,
		markdown: Array.from({ length: count(12) }, () => pick(blocks)()).join(pick(["\n\n", "\n", "\n\n\n"])),
	}));
}

/** mulberry32. */
function seeded(seed: number) {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
}
