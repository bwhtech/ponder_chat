import { toast } from "../toasts";
import { nextTick } from "vue";
import { findSource, resolveRange, type Citation } from "./citations";

/**
 * Marks cited text in a reply with the CSS Custom Highlight API, so the page's own
 * selection is left alone. Two marks: the quote whose comment is being written, and a
 * short flash on the quote that "Go to source" scrolled to (style.css).
 */
const COMMENT = "ponder-cite-comment";
const FLASH = "ponder-cite-flash";
const FLASH_MS = 1800;

/** The registry, typed as the Map it is (the DOM lib here lacks its maplike methods). */
const registry = () => (CSS as unknown as { highlights: Map<string, Highlight> }).highlights;
const supported = () => typeof Highlight !== "undefined" && typeof CSS !== "undefined" && "highlights" in CSS;

/** Marks the quote while its comment is written. Returns the function that unmarks it. */
export function markQuote(range: Range): () => void {
	if (!supported()) return () => undefined;
	const highlight = new Highlight(range);
	registry().set(COMMENT, highlight);
	return () => {
		if (registry().get(COMMENT) === highlight) registry().delete(COMMENT);
	};
}

let unflash: (() => void) | null = null;

function flash(range: Range) {
	unflash?.();
	if (supported()) {
		const highlight = new Highlight(range);
		registry().set(FLASH, highlight);
		const timer = setTimeout(() => unflash?.(), FLASH_MS);
		unflash = () => {
			clearTimeout(timer);
			if (registry().get(FLASH) === highlight) registry().delete(FLASH);
			unflash = null;
		};
		return;
	}
	// Without the API, the quote becomes the selection.
	const selection = document.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

/**
 * Scrolls to the reply a citation came from and flashes the quote. `showEarlier` renders
 * older messages when the reply is above the ones on screen; it returns false when there
 * are none left.
 */
export async function revealCitation(citation: Citation, showEarlier: () => boolean) {
	let source = findSource(citation.messageId);
	while (!source && showEarlier()) {
		await nextTick();
		source = findSource(citation.messageId);
	}
	if (!source) {
		toast.warning("The quoted reply is no longer in this chat. The quote is still saved.");
		return;
	}
	const range = resolveRange(source, citation);
	const target = range?.startContainer.parentElement ?? source;
	// An instant jump: the chat's scroller (message-scroller/) reads a smooth scroll it did not start as a
	// fight over the position and pulls back mid-way, so the flash does the showing.
	target.scrollIntoView({ block: "center" });
	if (range) flash(range);
	else toast.warning("The quoted text has changed. Showing the reply it came from.");
}
