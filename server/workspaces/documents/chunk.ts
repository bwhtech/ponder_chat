import type { DocumentPage } from "./document.ts";
import { blocksOf, type Block, type HeadingRule, type TableBlock } from "./markdown-blocks.ts";
import { splitText } from "./split-text.ts";

/**
 * Splits a document into passages by its structure, not by a count of characters
 * (docs/workspaces-plan.md, "Where Ponder does better than Flow"):
 *
 * - A heading starts a new passage. A section shorter than MIN joins the next one.
 * - Paragraphs are packed up to TARGET. A longer paragraph is cut at lines, then at
 *   sentences, then at words.
 * - A table row is never cut. A table up to MAX stays whole; a longer one is split by
 *   rows, and each part starts with the header row and its separator line. A row that
 *   does not fit in MAX with its header is a passage of its own, past MAX: the embedding
 *   models take far more. Only a row past MAX_ROW is cut, and each piece has the header.
 * - A header past MAX_HEADER is not repeated: it is text of its own, and its rows follow
 *   it as lines. Repeated, a header of 50,000 characters over 2,000 short rows would make
 *   100 million characters of passages from a file of 54 KB.
 * - Each passage has a location line, "<document> › <headings> (page N)", which is
 *   embedded with it, so a dose in a table part still says which table it is in.
 *
 * Pure and deterministic: the same pages always give the same passages.
 */
export const TARGET = 1_000;
export const MAX = 2_000;
/** A table row up to this length is never cut. */
export const MAX_ROW = 8_000;
/** A table's header (its header row and separator line) up to this length is repeated in each part. */
export const MAX_HEADER = MAX;
const MIN = 300;
/** The location names at most this many headings, the nearest ones. */
const MAX_PATH = 3;

export type Passage = {
	/** 0, 1, 2… in reading order. */
	ordinal: number;
	/** The page the passage starts on; null in a text document. */
	page: number | null;
	/** "Nephrology manual › Peritonitis › Table 5 (page 251)". */
	location: string;
	/** The passage's Markdown, at most MAX characters, except a table row that is longer with its header. */
	content: string;
};

export type ChunkInput = { name: string; pages: ReadonlyArray<DocumentPage>; headings: HeadingRule };

/** How many passages, how long one, and how many characters in all (location lines too). */
export type ChunkBudget = { readonly passages: number; readonly passageChars: number; readonly chars: number };

const UNBOUNDED: ChunkBudget = { passages: Infinity, passageChars: Infinity, chars: Infinity };

export function chunkDocument(input: ChunkInput): Passage[] {
	return chunkWithin(input, UNBOUNDED)!;
}

/**
 * The passages, or null when they would pass the budget. It stops as soon as they do,
 * before it makes the rest: the worker of prepare-text.ts must not run out of memory first.
 */
export function chunkWithin({ name, pages, headings }: ChunkInput, budget: ChunkBudget): Passage[] | null {
	const packer = new Packer();
	for (const [index, block] of blocksOf(pages, headings).entries()) {
		for (const unit of unitsOf(block, index)) {
			packer.add(unit);
			if (packer.passages > budget.passages || packer.chars > budget.chars) return null;
		}
	}
	const passages = packer.finish().map((draft, ordinal) => ({ ordinal, page: draft.page, location: locationLine(name, draft.path ?? draft.headingPath, draft.page), content: draft.text }));
	let chars = 0;
	for (const passage of passages) {
		if (passage.content.length > budget.passageChars) return null;
		chars += passage.location.length + passage.content.length;
	}
	return passages.length <= budget.passages && chars <= budget.chars ? passages : null;
}

/** What is embedded and searched for keywords: the location line, then the content. */
export function embeddingText(passage: Pick<Passage, "location" | "content">) {
	return `${passage.location}\n${passage.content}`;
}

export function locationLine(name: string, path: ReadonlyArray<string>, page: number | null) {
	const where = [name, ...path.slice(-MAX_PATH)].join(" › ");
	return page === null ? where : `${where} (page ${page})`;
}

/**
 * The pieces the packer works with. A heading or a row is never cut. `block` tells which
 * pieces came from one block, so they join with one line break, not two.
 */
type Unit = {
	kind: "heading" | "text" | "row";
	text: string;
	page: number | null;
	path: string[];
	block: number;
	/** For a row: its table's header and the length of the whole table. None when the header is not repeated. */
	table?: { header: string; length: number };
};

/** One at a time: a table of a million rows is not turned into a million units at once. */
function* unitsOf(block: Block, index: number): Generator<Unit> {
	const place = { page: block.page, path: block.path, block: index };
	const asText = (text: string) => splitText(text, TARGET).map((piece): Unit => ({ ...place, kind: "text", text: piece }));
	if (block.kind === "heading") yield { ...place, kind: "heading", text: block.text };
	else if (block.kind === "text") yield* asText(block.text);
	else if (block.rows.length === 0) yield* asText(block.header);
	else yield* tableUnits(block, place, asText);
}

function* tableUnits(block: TableBlock, place: Pick<Unit, "page" | "path" | "block">, asText: (text: string) => Unit[]): Generator<Unit> {
	// A header too long to repeat goes first, as text. Its rows are rows with no table, packed as lines.
	const repeated = block.header.length <= MAX_HEADER;
	if (!repeated) yield* asText(block.header);
	const table = repeated ? { header: block.header, length: block.header.length + 1 + rowsLength(block.rows) } : undefined;
	// Each piece of a cut row is longer than MAX, so it is a passage of its own, and gets the header.
	for (const row of block.rows) for (const text of row.length <= MAX_ROW ? [row] : splitText(row, MAX_ROW)) yield { ...place, kind: "row", text, table };
}

type Draft = {
	text: string;
	page: number | null;
	/** The headings shared by the passage's text; null while it has only headings. */
	path: string[] | null;
	/** The path of its last heading, for a passage of headings alone. */
	headingPath: string[];
	headingsOnly: boolean;
	/** It starts at a heading, or at the start of the document: a small one can take the next section. */
	startsSection: boolean;
	lastBlock: number;
	tableHeader: string | null;
};

/** Packs units into passages, in order. */
class Packer {
	private done: Draft[] = [];
	private draft: Draft | null = null;
	/** The characters of the passages done. */
	chars = 0;

	get passages() {
		return this.done.length;
	}

	add(unit: Unit) {
		if (this.draft && !this.fits(this.draft, unit)) this.flush();
		const addition = this.addition(this.draft, unit);
		const draft = (this.draft ??= {
			text: "",
			page: unit.page,
			path: null,
			headingPath: unit.path,
			headingsOnly: true,
			startsSection: unit.kind === "heading" || this.done.length === 0,
			lastBlock: unit.block,
			tableHeader: null,
		});
		draft.text += addition.joiner + addition.text;
		if (unit.kind === "heading") draft.headingPath = unit.path;
		else draft.path = draft.path === null ? unit.path : commonPrefix(draft.path, unit.path);
		draft.headingsOnly &&= unit.kind === "heading";
		draft.lastBlock = unit.block;
		draft.tableHeader = unit.table ? unit.table.header : null;
	}

	finish() {
		this.flush();
		// Headings alone, before a unit too big to join them, open the next passage: the
		// location line may cut a long heading or leave it out. At the end, they stay alone.
		const kept: Draft[] = [];
		let headings: Draft | null = null;
		for (const draft of this.done) {
			const merged: Draft = headings ? { ...draft, text: `${headings.text}\n\n${draft.text}`, page: headings.page } : draft;
			headings = merged.headingsOnly ? merged : null;
			if (!merged.headingsOnly) kept.push(merged);
		}
		if (headings) kept.push(headings);
		return kept;
	}

	private flush() {
		if (this.draft) {
			this.done.push(this.draft);
			this.chars += this.draft.text.length;
		}
		this.draft = null;
	}

	private fits(draft: Draft, unit: Unit) {
		const length = draft.text.length;
		const small = draft.headingsOnly || length < MIN;
		if (unit.kind === "heading") return (draft.headingsOnly || (draft.startsSection && length < MIN)) && length + 2 + unit.text.length <= TARGET;
		const addition = this.addition(draft, unit);
		const wholeTable = unit.table !== undefined && unit.table.length <= MAX;
		const startsTable = unit.table !== undefined && addition.text.startsWith(unit.table.header);
		// A table that fits in MAX is placed whole: its first row checks the whole table, and the other rows then fit.
		if (wholeTable && startsTable) return length + 2 + unit.table!.length <= (small ? MAX : TARGET);
		return length + addition.joiner.length + addition.text.length <= (small || wholeTable ? MAX : TARGET);
	}

	/** The text a unit adds. A row brings its table's header when the passage does not have it yet. */
	private addition(draft: Draft | null, unit: Unit) {
		const sameBlock = draft !== null && draft.lastBlock === unit.block;
		const joiner = draft === null ? "" : sameBlock ? "\n" : "\n\n";
		if (unit.table && !(sameBlock && draft?.tableHeader === unit.table.header)) return { joiner: draft === null ? "" : "\n\n", text: `${unit.table.header}\n${unit.text}` };
		return { joiner, text: unit.text };
	}
}

/** The length of the rows joined by line breaks, without joining them. */
function rowsLength(rows: ReadonlyArray<string>) {
	let length = rows.length - 1;
	for (const row of rows) length += row.length;
	return length;
}

function commonPrefix(a: string[], b: string[]) {
	let length = 0;
	while (length < a.length && length < b.length && a[length] === b[length]) length++;
	return a.slice(0, length);
}
