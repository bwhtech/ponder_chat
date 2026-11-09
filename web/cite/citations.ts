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
const CONTEXT_LENGTH = 32;

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

// --- Finding the text ------------------------------------------------------

/** The element around each reply's text; its value is the message id. */
export const SOURCE_ATTRIBUTE = "data-cite-source";
const EXCLUDED = "button, input, textarea, select, [role=button], [contenteditable], [hidden], script, style, template, noscript, svg, .katex-mathml";
const BLOCK =
	"address, article, aside, blockquote, dd, div, dl, dt, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, td, th, tr, ul";

const collapse = (text: string) => text.replace(/\s+/g, " ");

function splitsSurrogatePair(text: string, offset: number): boolean {
	const before = text.charCodeAt(offset - 1);
	const after = text.charCodeAt(offset);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function createSelector(text: string, rawStart: number, rawEnd: number): TextSelector | null {
	const quote = text.slice(rawStart, rawEnd);
	if (!quote.trim()) return null;
	const normalized = collapse(text);
	let start = collapse(text.slice(0, rawStart)).length;
	if (rawStart > 0 && /\s/.test(text[rawStart - 1]!) && /\s/.test(text[rawStart]!)) start -= 1;
	const end = collapse(text.slice(0, rawEnd)).length;
	let prefixStart = Math.max(0, start - CONTEXT_LENGTH);
	let suffixEnd = Math.min(normalized.length, end + CONTEXT_LENGTH);
	if (splitsSurrogatePair(normalized, prefixStart)) prefixStart += 1;
	if (splitsSurrogatePair(normalized, suffixEnd)) suffixEnd -= 1;
	return { text: quote, start, end, prefix: normalized.slice(prefixStart, start), suffix: normalized.slice(end, suffixEnd) };
}

/** Where the quote is in the reply's collapsed text, or null when it is gone or ambiguous. */
export function findQuote(text: string, selector: TextSelector): { start: number; end: number } | null {
	const normalized = collapse(text);
	const quote = collapse(selector.text);
	if (!quote.trim()) return null;
	const prefix = collapse(selector.prefix);
	const suffix = collapse(selector.suffix);
	const inContext = (start: number, end: number) =>
		normalized.slice(Math.max(0, start - prefix.length), start) === prefix && normalized.slice(end, end + suffix.length) === suffix;

	let match =
		selector.end - selector.start === quote.length && normalized.slice(selector.start, selector.end) === quote && inContext(selector.start, selector.end)
			? { start: selector.start, end: selector.end }
			: null;
	let only: { start: number; end: number } | null = null;
	let count = 0;
	for (let start = normalized.indexOf(quote); start !== -1; start = normalized.indexOf(quote, start + 1)) {
		const end = start + quote.length;
		count += 1;
		only = { start, end };
		if (!inContext(start, end)) continue;
		if (match && match.start !== start) return null;
		match = { start, end };
	}
	return match ?? (count === 1 ? only : null);
}

type Chunk = { node: Text; start: number; end: number };

/** The reply's visible text, with a line break between blocks, and where each text node sits in it. */
function readText(root: HTMLElement) {
	const parts: string[] = [];
	const chunks: Chunk[] = [];
	let length = 0;
	let separator = false;
	const visit = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node as Text;
			if (!text.length) return;
			if (separator && length > 0) {
				parts.push("\n");
				length += 1;
			}
			separator = false;
			chunks.push({ node: text, start: length, end: length + text.length });
			parts.push(text.data);
			length += text.length;
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		const element = node as Element;
		if (element.matches(EXCLUDED)) return;
		const block = element.matches(BLOCK);
		if (block || element.tagName === "BR") separator = true;
		for (const child of Array.from(element.childNodes)) visit(child);
		if (block) separator = true;
	};
	visit(root);
	return { text: parts.join(""), chunks };
}

const excluded = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest(EXCLUDED) ?? null;

/** The first or last text node the range really selects; triple-click ranges end at the next block's offset 0. */
function boundary(range: Range, node: Node, last: boolean): Text | null {
	if (!range.intersectsNode(node)) return null;
	if (node.nodeType === Node.TEXT_NODE) {
		const text = node as Text;
		const start = node === range.startContainer ? range.startOffset : 0;
		const end = node === range.endContainer ? range.endOffset : text.length;
		return start < end && !excluded(text) ? text : null;
	}
	for (let child = last ? node.lastChild : node.firstChild; child; child = last ? child.previousSibling : child.nextSibling) {
		const found = boundary(range, child, last);
		if (found) return found;
	}
	return null;
}

/** The selection as a citation selector, when it lies inside one reply in `area`. */
export function captureSelection(area: HTMLElement, selection: Selection | null): { messageId: string; source: HTMLElement; selector: TextSelector; range: Range } | null {
	if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
	const range = selection.getRangeAt(0).cloneRange();
	const first = boundary(range, range.commonAncestorContainer, false);
	const last = boundary(range, range.commonAncestorContainer, true);
	if (!first || !last) return null;
	const source = first.parentElement?.closest<HTMLElement>(`[${SOURCE_ATTRIBUTE}]`);
	if (!source || !area.contains(source) || !source.contains(last)) return null;
	range.setStart(first, first === range.startContainer ? range.startOffset : 0);
	range.setEnd(last, last === range.endContainer ? range.endOffset : last.length);

	const stream = readText(source);
	let rawStart: number | null = null;
	let rawEnd = 0;
	for (const chunk of stream.chunks) {
		if (!range.intersectsNode(chunk.node)) continue;
		const start = range.startContainer === chunk.node ? range.startOffset : 0;
		const end = range.endContainer === chunk.node ? range.endOffset : chunk.end - chunk.start;
		if (start === end) continue;
		rawStart ??= chunk.start + start;
		rawEnd = chunk.start + end;
	}
	if (rawStart === null) return null;
	const selector = createSelector(stream.text, rawStart, rawEnd);
	const messageId = source.getAttribute(SOURCE_ATTRIBUTE);
	return selector && messageId ? { messageId, source, selector, range } : null;
}

/** An offset in the collapsed text, back in the raw text. */
function rawOffset(text: string, offset: number): number {
	let at = 0;
	for (const match of text.matchAll(/\s+|\S+/g)) {
		const space = /\s/.test(match[0][0]!);
		const length = space ? 1 : match[0].length;
		if (offset <= at + length) return match.index + (space && offset > at ? match[0].length : offset - at);
		at += length;
	}
	return text.length;
}

/** The DOM range of a citation inside its reply, or null when the text is no longer there. */
export function resolveRange(root: HTMLElement, selector: TextSelector): Range | null {
	const stream = readText(root);
	const match = findQuote(stream.text, selector);
	if (!match) return null;
	const start = rawOffset(stream.text, match.start);
	const end = rawOffset(stream.text, match.end);
	const first = stream.chunks.find((chunk) => chunk.end > start);
	const last = stream.chunks.findLast((chunk) => chunk.start < end);
	if (!first || !last) return null;
	const range = root.ownerDocument.createRange();
	range.setStart(first.node, Math.max(0, start - first.start));
	range.setEnd(last.node, Math.min(last.node.length, end - last.start));
	return range.collapsed ? null : range;
}

export function findSource(messageId: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[${SOURCE_ATTRIBUTE}="${CSS.escape(messageId)}"]`);
}
