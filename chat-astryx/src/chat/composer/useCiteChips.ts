import { useEffect, useRef, useState, type RefObject } from "react";
import { findSource, resolveRange, withComment, type Citation } from "../../cite/citations";
import { markQuote, revealCitation } from "../../cite/highlight";
import { useCiteSelection } from "../../cite/selection";

/**
 * Citations: selecting text in a reply shows a Cite button (cite/selection.ts). Cite puts the
 * quote in the message box as a chip and opens a field for an optional comment; the quoted
 * text stays marked while the comment is written. Adapted from T3 Code.
 */
export function useCiteChips(area: RefObject<HTMLElement | null>, focusField: () => void, showEarlier?: () => boolean) {
	const [chips, setChips] = useState<Citation[]>([]);
	/** The chip whose comment is open. */
	const [editing, setEditing] = useState<number | null>(null);
	const { pending, dismiss } = useCiteSelection(area);
	const unmarkQuote = useRef(() => {});
	/**
	 * The open editor belongs to a quote Cite just added. Like T3 Code, cancelling that first
	 * comment (Cancel, Escape, or a click away with nothing written) takes the quote out again;
	 * only Save keeps it. Cancelling a later edit (the pencil) only closes the editor.
	 */
	const newCite = useRef(false);
	useEffect(() => () => unmarkQuote.current(), []);

	function cite() {
		if (!pending || pending.tooLong) return;
		document.getSelection()?.removeAllRanges();
		dismiss();
		// The same quote again opens its chip rather than add a second one (the chips are keyed by range).
		const { citation } = pending;
		const same = chips.findIndex((chip) => chip.messageId === citation.messageId && chip.start === citation.start && chip.end === citation.end);
		if (same !== -1) return edit(same, chips[same], pending.range);
		setChips((list) => [...list, pending.citation]);
		edit(chips.length, pending.citation, pending.range);
		newCite.current = true;
	}

	/** Opens a chip's comment editor, and marks its quote while the quote is on screen. */
	function edit(index: number, citation = chips[index], range?: Range | null) {
		newCite.current = false;
		unmarkQuote.current();
		if (!citation) return;
		if (range === undefined) {
			const source = findSource(citation.messageId);
			range = source && resolveRange(source, citation);
		}
		const bounds = area.current?.getBoundingClientRect();
		if (range && bounds && isInside(range.getBoundingClientRect(), bounds)) unmarkQuote.current = markQuote(range);
		setEditing(index);
	}

	function close() {
		newCite.current = false;
		unmarkQuote.current();
		unmarkQuote.current = () => {};
		setEditing(null);
		focusField();
	}

	/** Cancel, Escape, or a click away that changed nothing. */
	function cancel(index: number) {
		if (newCite.current) remove(index);
		else close();
	}

	function save(index: number, comment: string) {
		setChips((list) => list.map((citation, at) => (at === index ? withComment(citation, comment) : citation)));
		close();
	}

	function remove(index: number) {
		if (editing === index) close();
		else if (editing !== null && editing > index) setEditing(editing - 1);
		setChips((list) => list.filter((_, at) => at !== index));
		focusField();
	}

	/** Takes the quotes, for the message going out, and empties the chips. */
	function take() {
		if (editing !== null) close();
		setChips([]);
		return chips;
	}

	return {
		chips,
		/** Gives quotes back to the chips when a message did not go out. */
		restore: setChips,
		editing,
		pending,
		cite,
		edit: (index: number) => edit(index),
		cancel,
		save,
		remove,
		take,
		reveal: (citation: Citation) => void revealCitation(citation, showEarlier),
	};
}

function isInside(rect: DOMRect, bounds: DOMRect) {
	return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
}
