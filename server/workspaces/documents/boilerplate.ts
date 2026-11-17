/**
 * Drops the page header and footer lines that LiteParse keeps. The nephrology manual has
 * "MAN/RPT/NEPH ... Pg. 250 of 398" and "Prepared by: ..." on every page; LiteParse strips
 * them from most pages, but keeps them on about 160, in two spellings, and the footer's
 * last line comes out as a heading ("#### Sundarraj & Dr. Joseph Johny"). Left in, they
 * would be in many passages, and the footer would be the heading of the next page's
 * first passage.
 *
 * A line counts as repeated when its letters alone (no digits, marks or spaces) are on at
 * least 20% of the pages. In both manuals, the header lines are on 39 to 42% of the pages
 * and the next line on 7%. A line that is only the page's own number, or a "---" line,
 * goes too. Table rows are kept: a table header can repeat on purpose.
 */
const MIN_PAGES = 4;
const SHARE = 0.2;
const MAX_LINE = 200;
const MIN_LETTERS = 4;
/** A thematic break: LiteParse puts one above each page's footer. */
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;

export function dropRepeatedLines<P extends { page: number | null; markdown: string }>(pages: P[]): P[] {
	const repeated = pages.length < MIN_PAGES ? new Set<string>() : repeatedLines(pages);
	return pages.map((page) => ({ ...page, markdown: withoutLines(page, repeated) }));
}

function repeatedLines(pages: ReadonlyArray<{ markdown: string }>) {
	const pagesWith = new Map<string, number>();
	for (const page of pages) {
		const seen = new Set(page.markdown.split("\n").flatMap(letters));
		for (const line of seen) pagesWith.set(line, (pagesWith.get(line) ?? 0) + 1);
	}
	const least = Math.max(3, Math.ceil(pages.length * SHARE));
	return new Set([...pagesWith].filter(([, count]) => count >= least).map(([line]) => line));
}

function withoutLines(page: { page: number | null; markdown: string }, repeated: ReadonlySet<string>) {
	const pageNumber = page.page === null ? null : String(page.page);
	const kept = page.markdown.split("\n").filter((line) => line.trim() !== pageNumber && !RULE.test(line.trim()) && !letters(line).some((key) => repeated.has(key)));
	return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The line's letters, lowercase, as a list of none or one, so that flatMap skips lines that can't be boilerplate. */
function letters(line: string): string[] {
	const trimmed = line.trim();
	if (trimmed.length > MAX_LINE || trimmed.startsWith("|")) return [];
	const key = trimmed
		.replace(/<[^>]+>/g, "")
		.toLowerCase()
		.replace(/[^\p{L}]/gu, "");
	return key.length >= MIN_LETTERS ? [key] : [];
}
