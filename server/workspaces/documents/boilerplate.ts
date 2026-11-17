/**
 * Drops the page header and footer lines that LiteParse keeps. The nephrology manual has
 * "MAN/RPT/NEPH ... Pg. 250 of 398" and "Prepared by: ..." on every page; LiteParse strips
 * them from most pages, but keeps them on about 160, in two spellings, and the footer's
 * last line comes out as a heading ("#### Sundarraj & Dr. Joseph Johny"). Left in, they
 * would be in many passages, and the footer would be the heading of the next page's
 * first passage.
 *
 * A dropped line is body text lost, and in a manual of doses that is the worst outcome,
 * so a line stays when in doubt:
 *
 * - Only the first and last EDGE lines of a page are looked at. In the manual, the header
 *   is in the first 3 and the footer in the last 3.
 * - A line that repeats word for word (marks and spaces aside) at the edge of at least
 *   20% of the pages goes, but the first page with it keeps its copy. The manual's header
 *   lines are on 39% of the pages.
 * - Lines that differ only in their numbers go only when one of the numbers follows the
 *   page ("Pg. 250", "Pg. 251"), on at least 20% of the pages. "Take 5 mg" and "Take 10 mg"
 *   stay.
 * - At the edge, a line that is only the page's own number, or a "---" line, goes too.
 *
 * Table rows are kept: a table header can repeat on purpose.
 */
const MIN_PAGES = 4;
const SHARE = 0.2;
const EDGE = 4;
const MAX_LINE = 200;
const MIN_LETTERS = 4;
/** A thematic break: LiteParse puts one above each page's footer. */
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;

type Page = { page: number | null; markdown: string };

export function dropRepeatedLines<P extends Page>(pages: P[]): P[] {
	const lines = pages.map((page) => page.markdown.split("\n"));
	const dropped = new Boilerplate(pages, lines).find();
	return pages.map((page, index) => ({ ...page, markdown: withoutLines(lines[index], dropped[index]) }));
}

/** A line in a page's first or last EDGE lines. `index` is its place in the page's lines. */
type EdgeLine = { page: number; index: number; pageNumber: number | null; text: string };

/** Finds, for each page, the indexes of its header and footer lines. */
class Boilerplate {
	private readonly dropped: Set<number>[];
	private readonly edges: EdgeLine[];
	/** The pages that a line must be on to be a header or a footer. */
	private readonly least: number;

	constructor(
		private readonly pages: ReadonlyArray<Page>,
		lines: string[][],
	) {
		this.dropped = pages.map(() => new Set());
		this.edges = pages.flatMap((page, at) => edgeIndexes(lines[at]).map((index) => ({ page: at, index, pageNumber: page.page, text: lines[at][index].trim() })));
		this.least = Math.max(3, Math.ceil(pages.length * SHARE));
	}

	find() {
		for (const edge of this.edges) if (edge.text === String(edge.pageNumber) || RULE.test(edge.text)) this.drop(edge);
		if (this.pages.length >= MIN_PAGES) {
			this.dropSameLines();
			this.dropPageNumbered();
		}
		return this.dropped;
	}

	/** Lines that repeat word for word. The first copy stays, in case it is body text after all. */
	private dropSameLines() {
		for (const group of groupBy(this.edges, (edge) => candidate(edge.text) && plain(edge.text)).values()) {
			if (pageCount(group) >= this.least) for (const edge of group.slice(1)) this.drop(edge);
		}
	}

	/** Lines that differ only in their numbers, when a number follows the page. */
	private dropPageNumbered() {
		const numbered = this.edges.filter((edge) => edge.pageNumber !== null && /\d/.test(edge.text));
		for (const group of groupBy(numbered, (edge) => candidate(edge.text) && plain(edge.text).replace(/\d+/g, "#")).values()) {
			const paged = followingThePage(group);
			if (pageCount(paged) >= this.least) for (const edge of paged) this.drop(edge);
		}
	}

	private drop(edge: EdgeLine) {
		this.dropped[edge.page].add(edge.index);
	}
}

/**
 * The lines of a group whose number at one place is the page number plus the same
 * offset: the largest such set. "Pg. 250 of 398" on page 250 is offset 0 at place 0.
 */
function followingThePage(group: EdgeLine[]) {
	const byOffset = new Map<string, EdgeLine[]>();
	for (const edge of group) {
		for (const [place, number] of numbersIn(edge.text).entries()) addTo(byOffset, `${place}:${number - edge.pageNumber!}`, edge);
	}
	let best: EdgeLine[] = [];
	for (const edges of byOffset.values()) if (pageCount(edges) > pageCount(best)) best = edges;
	return best;
}

/** The indexes of a page's first and last EDGE lines that are not blank. */
function edgeIndexes(lines: string[]) {
	const filled = lines.flatMap((line, index) => (line.trim() === "" ? [] : [index]));
	return [...new Set([...filled.slice(0, EDGE), ...filled.slice(-EDGE)])];
}

/** A line that could be a header or a footer: short, not a table row, with a few letters. */
function candidate(text: string) {
	return text.length <= MAX_LINE && !text.startsWith("|") && (text.match(/\p{L}/gu)?.length ?? 0) >= MIN_LETTERS;
}

/**
 * The line lowercase, without HTML, Markdown marks or spaces, so the two spellings of the
 * header match ("Issue :1**", "Issue: 1"). Other marks stay: "1.5 mg" is not "15 mg".
 */
function plain(text: string) {
	return text
		.replace(/<[^>]+>/g, "")
		.replace(/[*_#`\s]/g, "")
		.toLowerCase();
}

function numbersIn(text: string) {
	return (plain(text).match(/\d+/g) ?? []).map(Number);
}

/** Groups by key; a false key leaves the item out. */
function groupBy<T>(items: ReadonlyArray<T>, key: (item: T) => string | false) {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const found = key(item);
		if (found !== false) addTo(groups, found, item);
	}
	return groups;
}

function addTo<T>(groups: Map<string, T[]>, key: string, item: T) {
	const group = groups.get(key);
	if (group) group.push(item);
	else groups.set(key, [item]);
}

function pageCount(edges: ReadonlyArray<EdgeLine>) {
	return new Set(edges.map((edge) => edge.page)).size;
}

function withoutLines(lines: string[], dropped: ReadonlySet<number>) {
	const kept = lines.filter((_, index) => !dropped.has(index));
	return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
