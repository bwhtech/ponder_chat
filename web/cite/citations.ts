import type { UIMessage } from "ai";

/**
 * Citations: text the person selected in an earlier reply and quoted in a new message,
 * with an optional comment. Adapted from T3 Code's assistant citations.
 *
 * A citation finds its text again with a text-quote selector: the quote, its place in the
 * reply's text (with whitespace collapsed), and up to 32 characters before and after it.
 * The place can drift when a reply renders differently; the context settles which copy
 * of a repeated quote it is.
 */
export const CITATION_PART = "data-citation";
export const CITATION_MAX_TEXT = 8_000;
export const CITATION_MAX_COMMENT = 8_000;

export type TextSelector = { text: string; start: number; end: number; prefix: string; suffix: string };
export type Citation = TextSelector & { messageId: string; comment?: string };
export type CitationPart = { type: typeof CITATION_PART; data: Citation };

export const citationPart = (citation: Citation): CitationPart => ({ type: CITATION_PART, data: citation });

/** The citations in a message the person sent. */
export function chosenCitations(message: UIMessage | undefined): Citation[] {
	if (message?.role !== "user") return [];
	return message.parts.flatMap((part) => (part.type === CITATION_PART && isCitation((part as CitationPart).data) ? [(part as CitationPart).data] : []));
}

function isCitation(value: unknown): value is Citation {
	const citation = value as Citation | undefined;
	return typeof citation?.text === "string" && typeof citation.messageId === "string";
}

/** The chip's label: the comment if there is one, else the quote, on one line. */
export function citationLabel(citation: Citation): string {
	const preview = (citation.comment?.trim() || citation.text).replace(/\s+/g, " ");
	return preview.length > 64 ? `${preview.slice(0, 64)}…` : preview;
}

export function withComment(citation: Citation, comment: string): Citation {
	const { comment: _previous, ...rest } = citation;
	const trimmed = comment.trim();
	return trimmed ? { ...rest, comment: trimmed } : rest;
}
