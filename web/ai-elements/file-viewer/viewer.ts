import { readonly, shallowRef } from "vue";

/** A file that the viewer can show. */
export type ViewedFile = { name: string; url: string; mediaType: string };

const current = shallowRef<ViewedFile | null>(null);

/** The file open in the viewer, or null. One viewer for the whole app. */
export const viewedFile = readonly(current);

/** PDFs and the image types that browsers show. Other files open as a link. */
export function canView(mediaType: string, name = "") {
	return isPdf(mediaType, name) || /^image\/(png|jpe?g|gif|webp|avif)$/.test(mediaType);
}

export function isPdf(mediaType: string, name = "") {
	return mediaType === "application/pdf" || /\.pdf$/i.test(name);
}

export function viewFile(file: ViewedFile) {
	current.value = file;
}

export function closeViewer() {
	current.value = null;
}

/**
 * For a link to a file: opens the viewer on a plain click. A click with a modifier key,
 * or with the middle button, still opens the link as the browser would.
 */
export function viewOnClick(event: MouseEvent, file: ViewedFile) {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	if (!canView(file.mediaType, file.name)) return;
	event.preventDefault();
	viewFile(file);
}
