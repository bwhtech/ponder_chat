import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { PageReadReason } from "./document.ts";

/**
 * Reads every page of a PDF with LiteParse (@llamaindex/liteparse): Markdown with Markdown
 * tables, and signals for each page that say whether a picture or a scan holds what the
 * text layer does not. OCR stays off: a model reads those pages (page-reader.ts).
 *
 * The parse runs in a child process of LiteParse's own pool, which it kills after
 * PARSE_TIMEOUT_MS: the native core can't be stopped from this process.
 */
const PARSE_TIMEOUT_MS = 120_000;
/** A page goes to a model when one picture covers this much of it or more. */
const PICTURE_COVERAGE = 0.1;

export type LiteParsePage = {
	page: number;
	markdown: string;
	/** Why the page must go to a model, or none. */
	modelReason: Option.Option<PageReadReason>;
};

export type LiteParseResult = { pageCount: number; pages: LiteParsePage[] };

/** LiteParse loaded, but could not read this PDF, or took too long. */
export class LiteParseFailed extends Schema.TaggedError<LiteParseFailed>()("LiteParseFailed", {
	cause: Schema.Defect(),
}) {
	override get message() {
		return "LiteParse could not read the PDF.";
	}
}

/**
 * The pages, or none when LiteParse does not load here (its native core is missing for
 * this platform): the caller then reads the text layer with pdf-text.ts.
 */
export const parseWithLiteParse = Effect.fn("LiteParse.parse")(function* (data: Uint8Array) {
	const module = yield* Effect.tryPromise(() => import("@llamaindex/liteparse")).pipe(Effect.option);
	if (Option.isNone(module)) return Option.none<LiteParseResult>();
	const { LiteParse } = module.value;
	const result = yield* Effect.acquireUseRelease(
		Effect.sync(
			() =>
				new LiteParse({
					outputFormat: "markdown",
					ocrEnabled: false,
					includeComplexity: true,
					quiet: true,
					// No `![](img_p3_1.png)` lines: the files are not kept.
					imageMode: "off",
					poolSize: 1,
					parseTimeoutMs: PARSE_TIMEOUT_MS,
				}),
		),
		(parser) => Effect.tryPromise({ try: () => parser.parse(Buffer.from(data)), catch: (cause) => new LiteParseFailed({ cause }) }),
		(parser) => Effect.sync(() => parser.close()),
	);
	const pages = result.pages.map((page): LiteParsePage => ({ page: page.pageNum, markdown: clean(page.markdown), modelReason: modelReason(page.complexity) }));
	return Option.some<LiteParseResult>({ pageCount: result.totalPages, pages });
});

/** A page with no text comes out as an empty code fence ("```text\n\n```"). */
function clean(markdown: string) {
	return markdown.replace(/^```[\w-]*\n\s*```$/gm, "").trim();
}

/**
 * LiteParse's own `needsOcr` is not used: it is true for every page with a logo. A full-page
 * scan counts 0 in `largestImageCoverage`, so `fullPageImage` is the only sign of one.
 */
export function modelReason(complexity: { largestImageCoverage: number; fullPageImage: boolean } | undefined): Option.Option<PageReadReason> {
	if (!complexity) return Option.none();
	if (complexity.fullPageImage) return Option.some("scan");
	if (complexity.largestImageCoverage >= PICTURE_COVERAGE) return Option.some("picture");
	return Option.none();
}
