import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import { captureSelection, CITATION_MAX_TEXT, type Citation } from "./citations";

export type PendingCite = { citation: Citation; range: Range; x: number; y: number; tooLong: boolean };

/**
 * Watches for text selected in a reply inside `area`, for the floating Cite button.
 * The button shows once the pointer lets go (or a keyboard selection settles), under
 * the end of the selection, follows it while the chat scrolls, and goes away when the
 * selection does, or with Escape.
 */
export function useCiteSelection(area: Ref<HTMLElement | null>) {
	const pending = ref<PendingCite | null>(null);
	let pointerDown = false;
	let frame = 0;

	function update() {
		frame = 0;
		const root = area.value;
		if (!root || pointerDown) return;
		const captured = captureSelection(root, document.getSelection());
		if (!captured) {
			pending.value = null;
			return;
		}
		const place = placeFor(captured.range, root);
		if (!place) {
			pending.value = null;
			return;
		}
		pending.value = {
			citation: { messageId: captured.messageId, ...captured.selector },
			range: captured.range,
			tooLong: captured.selector.text.length > CITATION_MAX_TEXT,
			...place,
		};
	}

	/** Under the selection's last line, kept inside the window; null when the selection scrolled out of the chat. */
	function placeFor(range: Range, root: HTMLElement) {
		const lines = range.getClientRects();
		const last = lines.item(lines.length - 1) ?? range.getBoundingClientRect();
		const bounds = root.getBoundingClientRect();
		if (last.bottom < bounds.top || last.top > bounds.bottom) return null;
		return { x: Math.min(Math.max(8, last.right - 24), window.innerWidth - 96), y: Math.min(last.bottom + 6, window.innerHeight - 40) };
	}

	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(update);
	};
	const onPointerDown = (event: PointerEvent) => {
		if ((event.target as Element | null)?.closest("[data-cite-button]")) return;
		pointerDown = true;
		pending.value = null;
	};
	const onPointerUp = () => {
		if (!pointerDown) return;
		pointerDown = false;
		// The selection settles after pointerup (a double-click selects on the second up).
		setTimeout(schedule);
	};
	const onScroll = () => {
		const shown = pending.value;
		const root = area.value;
		if (!shown || !root) return;
		const place = placeFor(shown.range, root);
		pending.value = place ? { ...shown, ...place } : null;
	};
	const onKeydown = (event: KeyboardEvent) => {
		if (event.key === "Escape" && pending.value) pending.value = null;
	};

	onMounted(() => {
		document.addEventListener("selectionchange", schedule);
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("pointerup", onPointerUp, true);
		document.addEventListener("scroll", onScroll, true);
		document.addEventListener("keydown", onKeydown);
		window.addEventListener("resize", onScroll);
	});
	onBeforeUnmount(() => {
		cancelAnimationFrame(frame);
		document.removeEventListener("selectionchange", schedule);
		document.removeEventListener("pointerdown", onPointerDown, true);
		document.removeEventListener("pointerup", onPointerUp, true);
		document.removeEventListener("scroll", onScroll, true);
		document.removeEventListener("keydown", onKeydown);
		window.removeEventListener("resize", onScroll);
	});

	/** Hides the button until the next selection. */
	function dismiss() {
		pending.value = null;
	}

	return { pending, dismiss };
}
