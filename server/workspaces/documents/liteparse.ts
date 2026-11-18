import type { PageReadReason } from "./document.ts";

/**
 * Reads every page of a PDF with LiteParse (@llamaindex/liteparse): Markdown with Markdown
 * tables, and signals for each page that say whether a picture or a scan holds what the
 * text layer does not. OCR stays off: a model reads those pages (page-reader.ts).
 *
 * It runs in the worker of prepare-text.ts (parse-pdf.ts), never on the server's own
 * thread. LiteParse parses in a child process of its own and sends back every page with
 * each piece of text and its position: about 27 times the Markdown (16 MB for the
 * 398-page manual). The worker takes that in, and gives the server only the Markdown.
 * The child exits when the worker is stopped: its channel to the worker closes.
 */
/** A page goes to a model when one picture covers this much of it or more. */
const PICTURE_COVERAGE = 0.1;

export type LiteParsePage = {
	page: number;
	markdown: string;
	/** Why the page must go to a model, or null. Plain data: it is posted from the worker. */
	modelReason: PageReadReason | null;
};

export type LiteParseResult = { pageCount: number; pages: LiteParsePage[] };

/**
 * The pages, at most `maxPages` of them, with the PDF's page count; or null when LiteParse
 * does not load here (its native core is missing for this platform): the caller then
 * reads the text layer with pdf.js. Rejects when LiteParse can't read the PDF.
 */
export async function parseWithLiteParse(data: Uint8Array, maxPages: number): Promise<LiteParseResult | null> {
	const module = await import("@llamaindex/liteparse").catch(() => null);
	if (module === null) return null;
	const parser = new module.LiteParse({
		outputFormat: "markdown",
		ocrEnabled: false,
		includeComplexity: true,
		quiet: true,
		// No `![](img_p3_1.png)` lines: the files are not kept.
		imageMode: "off",
		maxPages,
		poolSize: 1,
	});
	try {
		const result = await parser.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
		const pages = result.pages.map((page): LiteParsePage => ({ page: page.pageNum, markdown: clean(page.markdown), modelReason: modelReason(page.complexity) }));
		return { pageCount: result.totalPages, pages };
	} finally {
		parser.close();
	}
}

/** A page with no text comes out as an empty code fence ("```text\n\n```"). */
function clean(markdown: string) {
	return markdown.replace(/^```[\w-]*\n\s*```$/gm, "").trim();
}

/**
 * LiteParse's own `needsOcr` is not used: it is true for every page with a logo. A full-page
 * scan counts 0 in `largestImageCoverage`, so `fullPageImage` is the only sign of one.
 */
export function modelReason(complexity: { largestImageCoverage: number; fullPageImage: boolean } | undefined): PageReadReason | null {
	if (!complexity) return null;
	if (complexity.fullPageImage) return "scan";
	if (complexity.largestImageCoverage >= PICTURE_COVERAGE) return "picture";
	return null;
}
