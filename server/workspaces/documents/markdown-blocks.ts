import type { DocumentPage } from "./document.ts";

/**
 * Splits a document's Markdown pages into blocks (headings, paragraphs, tables and code
 * fences), each with its page and the path of headings above it. chunk.ts packs the
 * blocks into passages.
 */
export type Block = HeadingBlock | TextBlock | TableBlock;
type Place = { page: number | null; path: string[] };
export type HeadingBlock = Place & { kind: "heading"; text: string };
export type TextBlock = Place & { kind: "text"; text: string };
/** `header` is the header row and its separator line, which each part of a split table repeats. */
export type TableBlock = Place & { kind: "table"; header: string; rows: string[] };

/**
 * How heading paths are made. In a PDF, the heading levels come from font sizes (LiteParse)
 * or from a model, and one page's "###" is another's "####": the path follows the numbers
 * ("2.3.1 Medical staff" is under "2.3 Staff list"), and a heading with no number is under
 * the last numbered one. In a Markdown file, the author's levels are kept.
 */
export type HeadingRule = "numbered" | "levels";

export function blocksOf(pages: ReadonlyArray<DocumentPage>, rule: HeadingRule): Block[] {
	const path = rule === "numbered" ? new NumberedPath() : new LevelPath();
	const blocks: Block[] = [];
	for (const page of pages) {
		for (const raw of rawBlocks(page.markdown)) {
			const heading = headingLine(raw, rule);
			const title = heading === null ? "" : headingTitle(heading);
			if (heading !== null && title) blocks.push({ kind: "heading", text: heading, page: page.page, path: path.enter(title, headingLevel(heading)) });
			else blocks.push(withPlace(raw, page.page, path.current()));
		}
	}
	return blocks;
}

/** A heading is one line; the others are lines of text or of a table. */
type RawBlock = { kind: "heading" | "text" | "table"; lines: string[] };

/** Tables are runs of lines that start with "|"; a code fence is one block; other blocks end at a blank line. */
function rawBlocks(markdown: string): RawBlock[] {
	const blocks: RawBlock[] = [];
	let open = null as RawBlock | null;
	let fence = null as RawBlock | null;
	for (const line of markdown.split("\n")) {
		const trimmed = line.trim();
		if (fence) {
			fence.lines.push(line);
			if (trimmed.startsWith("```")) fence = null;
		} else if (trimmed.startsWith("```")) {
			blocks.push((fence = { kind: "text", lines: [line] }));
			open = null;
		} else if (trimmed === "") open = null;
		else if (HEADING.test(trimmed) && trimmed.length <= MAX_HEADING) {
			blocks.push({ kind: "heading", lines: [trimmed] });
			open = null;
		} else {
			const kind = trimmed.startsWith("|") ? "table" : "text";
			if (open?.kind !== kind) blocks.push((open = { kind, lines: [] }));
			open.lines.push(kind === "table" ? trimmed : line.trimEnd());
		}
	}
	return blocks;
}

/**
 * The block's heading line, or null. In a PDF, a paragraph that is one short bold line is
 * a heading too: a model writes them so. One that ends with a full stop is a sentence.
 */
function headingLine(raw: RawBlock, rule: HeadingRule) {
	if (raw.kind === "heading") return raw.lines[0];
	const boldLine = raw.kind === "text" && raw.lines.length === 1 && /^\*\*[^*]{1,99}[^*.]\*\*:?$/.test(raw.lines[0].trim());
	return rule === "numbered" && boldLine ? raw.lines[0].trim() : null;
}

/** Pipe lines are a table only with a separator line under the first; else they are text, such as one "| a | b |" line. */
function withPlace(raw: RawBlock, page: number | null, path: string[]): Block {
	if (raw.kind !== "table" || !SEPARATOR.test(raw.lines[1] ?? "")) return { kind: "text", text: raw.lines.join("\n"), page, path };
	// A row of empty cells says nothing. LiteParse writes them under a page of text that it took for a table's header.
	const rows = raw.lines.slice(2).filter((row) => /[\p{L}\p{N}]/u.test(row));
	return { kind: "table", header: raw.lines.slice(0, 2).join("\n"), rows, page, path };
}

const HEADING = /^#{1,6}\s+\S/;
// LiteParse marks a whole bold paragraph as a heading at times; a line this long is text.
const MAX_HEADING = 200;
const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;
const NUMBER = /^(\d{1,2}(?:\.\d{1,2}){0,5})\.?\s+\S/;
const MAX_TITLE = 80;

/** "##" is 2; a bold line is under every Markdown heading. */
function headingLevel(line: string) {
	return line.match(/^#+/)?.[0].length ?? 7;
}

/** The heading's words, without Markdown or HTML marks, cut at a word. */
export function headingTitle(line: string) {
	const plain = line
		.replace(/^#{1,6}\s+/, "")
		.replace(/\s+#+\s*$/, "")
		.replace(/<[^>]+>/g, "")
		.replace(/[*_`]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/:$/, "");
	if (plain.length <= MAX_TITLE) return plain;
	const cut = plain.slice(0, MAX_TITLE);
	return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : MAX_TITLE)}…`;
}

/**
 * Headings by their numbers: "6.2.2.1" is under the headings above it whose numbers start
 * it ("6.2.2", "6"), whichever of them the document has. One heading with no number sits
 * under the last numbered one, until the next heading.
 */
class NumberedPath {
	private numbered: { number: string[]; title: string }[] = [];
	private unnumbered: string | null = null;

	enter(title: string, _level: number) {
		const number = title.match(NUMBER)?.[1].split(".");
		if (number === undefined) this.unnumbered = title;
		else {
			this.numbered = [...this.numbered.filter((entry) => isParent(entry.number, number)), { number, title }];
			this.unnumbered = null;
		}
		return this.current();
	}

	current() {
		const titles = this.numbered.map((entry) => entry.title);
		return this.unnumbered === null ? titles : [...titles, this.unnumbered];
	}
}

function isParent(parent: string[], child: string[]) {
	return parent.length < child.length && parent.every((part, index) => Number(part) === Number(child[index]));
}

/** Headings by their Markdown level: "##" is under the "#" above it. */
class LevelPath {
	private stack: { level: number; title: string }[] = [];

	enter(title: string, level: number) {
		this.stack = [...this.stack.filter((entry) => entry.level < level), { level, title }];
		return this.current();
	}

	current() {
		return this.stack.map((entry) => entry.title);
	}
}
