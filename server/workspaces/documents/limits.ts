import * as Schema from "effect/Schema";
import { MAX_TABLE_CHARS } from "./csv.ts";

/**
 * How large a document may be once it is read. The worker of prepare-text.ts checks these
 * before it answers, so the server's own thread never receives more: it copies the answer
 * in one go, before it can look at it.
 *
 * Measured on the largest documents that Ponder takes (uploads are at most 10 MB):
 * - a 10 MB CSV of short numbers: 16.7 million characters of text, 17,430 passages,
 *   17.6 million characters of passages with their location lines;
 * - a CSV of 20 short columns, 10 MB: about 21,000 passages, 1.3 times its text;
 * - the 398-page nephrology manual (5.5 MB): 570,000 characters, 873 passages.
 */
/** The text kept for a document: as large as a table may be (csv.ts). */
export const MAX_TEXT_CHARS = MAX_TABLE_CHARS;
/** Five times the manual. Each page with a picture may go to a model, which is paid for. */
export const MAX_PAGES = 2_000;
/** About 260 embedding calls of 96 passages. */
export const MAX_PASSAGES = 25_000;
/**
 * One passage at most. The chunker keeps each one under it (chunk.ts): a table row of
 * MAX_ROW with a header of MAX_HEADER, after a few headings.
 */
export const MAX_PASSAGE_CHARS = 12_000;
/** All passages with their location lines: twice the text. A header is repeated in each part of its table. */
export const MAX_PASSAGES_CHARS = 2 * MAX_TEXT_CHARS;

/** The document is read, but its pages, its text or its passages are past the limits above. */
export class DocumentTooLarge extends Schema.TaggedError<DocumentTooLarge>()("DocumentTooLarge", {
	reason: Schema.Literals(["pages", "text", "passages"]),
}) {
	override get message() {
		if (this.reason === "pages") return `The document is too large to read: it has more than ${MAX_PAGES.toLocaleString("en")} pages. Split it into smaller files.`;
		if (this.reason === "text") return "The document is too large to read: it has too much text. Split it into smaller files.";
		return "The document is too large to read: it makes too many passages. Split it into smaller files.";
	}
}

/** What the chunker may make (chunkWithin in chunk.ts). */
export const PASSAGE_BUDGET = { passages: MAX_PASSAGES, passageChars: MAX_PASSAGE_CHARS, chars: MAX_PASSAGES_CHARS } as const;
