import type { ViewedFile } from "frappe-ui-ai-elements";
import { computed, shallowRef, type Ref } from "vue";

/**
 * The side panel at the right of the chat: one for the whole app. It shows a file (a PDF,
 * an image, a CSV) or an artifact that a reply wrote (web/artifacts/).
 */
export type { ViewedFile };

/** document: Markdown. slides: HTML sections. html: one web page that runs (web/artifacts/html.ts). */
export type ArtifactKind = "document" | "slides" | "html";

/** An artifact as the panel reads it. `writing` is true while the reply still streams it. */
export type Artifact = { id: string; kind: ArtifactKind; title: string; content: string; writing: boolean };

export type PanelItem =
	| { type: "file"; key: string; file: ViewedFile }
	| { type: "artifact"; key: string; artifact: Readonly<Ref<Artifact>> };

const current = shallowRef<PanelItem | null>(null);

/** What the panel shows, or null when it is closed. A computed, not readonly(): a deep proxy breaks the artifact's own computed. */
export const panelItem = computed(() => current.value);

export function viewFile(file: ViewedFile) {
	current.value = { type: "file", key: `file:${file.url}`, file };
}

/** `key` names this version of the artifact, so its card in the chat can show that it is open. */
export function viewArtifact(key: string, artifact: Readonly<Ref<Artifact>>) {
	current.value = { type: "artifact", key, artifact };
}

export function closePanel() {
	current.value = null;
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
 * The chat's file viewer (frappe-ui-ai-elements' FileViewer, given in Shell.vue): a file the
 * panel can show opens there. Other files return false and open as a link.
 */
export function viewInPanel(file: ViewedFile) {
	if (!canView(file.mediaType, file.name)) return false;
	viewFile(file);
	return true;
}
