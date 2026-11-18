import { onBeforeUnmount, onMounted, ref } from "vue";

/**
 * The part of the screen the page can use while a phone's keyboard is up. On Android, the
 * keyboard shrinks the page (`interactive-widget=resizes-content`, index.html), so `100dvh`
 * follows it. Safari on iOS keeps the page full height under the keyboard and moves what shows
 * of it instead (the visual viewport), so the message box at the bottom of a chat or a
 * workspace can sit under the keyboard, and the header can scroll out of view. There, while the
 * keyboard is up, the shell takes the visible part's height and place (Shell.vue).
 */
export type Frame = { height: number; top: number };

/** What shows of the page, and the page's own height (window.visualViewport, the root element's clientHeight). */
export type Viewport = { height: number; offsetTop: number; scale: number; pageHeight: number };

/**
 * The keyboard covers this much of the page at least: less is the browser's own toolbar
 * coming and going, which 100dvh already follows.
 */
const KEYBOARD_PX = 120;

/**
 * The frame while a keyboard covers part of the page, or null when nothing does (a computer,
 * Android, or no keyboard). Pinching to zoom also makes the visible part smaller; the page is
 * not framed then, so zoom works as it always does.
 */
export function keyboardFrame({ height, offsetTop, scale, pageHeight }: Viewport): Frame | null {
	if (Math.abs(scale - 1) > 0.01) return null;
	if (pageHeight - height < KEYBOARD_PX) return null;
	return { height: Math.round(height), top: Math.round(offsetTop) };
}

/** The frame, kept up to date while the component is mounted. */
export function useKeyboardFrame() {
	const frame = ref<Frame | null>(null);
	const viewport = typeof window === "undefined" ? null : window.visualViewport;
	const update = () => {
		if (!viewport) return;
		const next = keyboardFrame({ height: viewport.height, offsetTop: viewport.offsetTop, scale: viewport.scale, pageHeight: document.documentElement.clientHeight });
		const now = frame.value;
		if (next?.height !== now?.height || next?.top !== now?.top) frame.value = next;
	};
	onMounted(() => {
		viewport?.addEventListener("resize", update);
		viewport?.addEventListener("scroll", update);
		update();
	});
	onBeforeUnmount(() => {
		viewport?.removeEventListener("resize", update);
		viewport?.removeEventListener("scroll", update);
	});
	return frame;
}
