import type { MouseEvent } from "react";
import { createStore } from "../lib/store";

/**
 * The side panel at the right of the chat: one for the whole app. It shows a file (a PDF,
 * an image, a CSV) or an artifact that a reply wrote (src/artifacts/).
 */
export type ViewedFile = { name: string; url: string; mediaType: string };

/** document: Markdown. slides: HTML sections. html: one web page that runs (src/artifacts/html.ts). */
export type ArtifactKind = "document" | "slides" | "html";

/** An artifact as the panel reads it. `writing` is true while the reply still streams it. */
export type Artifact = { id: string; kind: ArtifactKind; title: string; content: string; writing: boolean };

export type PanelItem = { type: "file"; key: string; file: ViewedFile } | { type: "artifact"; key: string; artifact: Artifact };

/** What the panel shows, or null when it is closed. */
export const panel = createStore<PanelItem | null>(null);

export function viewFile(file: ViewedFile) {
	panel.set({ type: "file", key: `file:${file.url}`, file });
}

/** `key` names this version of the artifact, so its card in the chat can show that it is open. */
export function viewArtifact(key: string, artifact: Artifact) {
	panel.set({ type: "artifact", key, artifact });
}

/** The card calls this as the reply streams, so an open artifact shows each new word. */
export function updateArtifact(key: string, artifact: Artifact) {
	panel.set((shown) => (shown?.type === "artifact" && shown.key === key ? { ...shown, artifact } : shown));
}

export function closePanel() {
	panel.set(null);
}

/** PDFs, CSV and TSV files, and the image types that browsers show. Other files open as a link. */
export function canView(mediaType: string, name = "") {
	return fileKind(mediaType, name) !== null;
}

export function fileKind(mediaType: string, name = ""): "pdf" | "image" | "table" | null {
	if (mediaType === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
	if (/^image\/(png|jpe?g|gif|webp|avif)$/.test(mediaType)) return "image";
	if (/^text\/(csv|tab-separated-values)$/.test(mediaType) || /\.(csv|tsv)$/i.test(name)) return "table";
	return null;
}

/**
 * For a link to a file: opens the panel on a plain click. A click with a modifier key,
 * or with the middle button, still opens the link as the browser would.
 */
export function viewOnClick(event: MouseEvent, file: ViewedFile) {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	if (!canView(file.mediaType, file.name)) return;
	event.preventDefault();
	viewFile(file);
}

/**
 * For a button that shows a file (a thumbnail, a chip): a plain click opens the panel, and a
 * click with Cmd or Ctrl, or a file the panel cannot show, opens it in a new tab.
 */
export function viewOrOpen(event: MouseEvent, file: ViewedFile) {
	if (!event.metaKey && !event.ctrlKey && !event.shiftKey && canView(file.mediaType, file.name)) return viewFile(file);
	window.open(file.url, "_blank", "noopener");
}
