import type { ViewedFile } from "frappe-ui-ai-elements";
import { computed, nextTick, shallowRef, type Ref } from "vue";
import type { WorkspaceDocument } from "../workspaces/documents";

/**
 * The side panel at the right of the chat: one for the whole app. It shows a file (a PDF,
 * an image, a CSV), an artifact that a reply wrote (web/artifacts/), or a workspace
 * document's Details (web/workspaces/DocumentDetails.vue).
 */
export type { ViewedFile };

/** document: Markdown. slides: HTML sections. html: one web page that runs (web/artifacts/html.ts). */
export type ArtifactKind = "document" | "slides" | "html";

/** An artifact as the panel reads it. `writing` is true while the reply still streams it. */
export type Artifact = { id: string; kind: ArtifactKind; title: string; content: string; writing: boolean };

/**
 * A document's Details. `document` is the document as its row had it when Details opened;
 * `current` reads it from the workspace's list as that changes (a "Try again" on the row).
 * `onChanged` hands the row each change of status that Details see first.
 */
export type DocumentDetailsRequest = {
	workspaceId: string;
	document: WorkspaceDocument;
	current: () => WorkspaceDocument | undefined;
	onChanged: (document: WorkspaceDocument) => void;
};

export type PanelItem =
	| { type: "file"; key: string; file: ViewedFile }
	| { type: "artifact"; key: string; artifact: Readonly<Ref<Artifact>> }
	| { type: "details"; key: string; details: DocumentDetailsRequest };

const current = shallowRef<PanelItem | null>(null);
// What had focus when the panel opened. On a phone the panel covers the page and takes focus;
// closing it gives focus back there.
let opener: HTMLElement | null = null;

/** `from` is where focus goes back on close, when that is not what has focus now, such as a menu's button. */
function show(item: PanelItem, from?: HTMLElement | null) {
	if (from) opener = from;
	else if (!current.value) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	current.value = item;
}

/** What the panel shows, or null when it is closed. A computed, not readonly(): a deep proxy breaks the artifact's own computed. */
export const panelItem = computed(() => current.value);

export function viewFile(file: ViewedFile) {
	show({ type: "file", key: `file:${file.url}`, file });
}

/** `key` names this version of the artifact, so its card in the chat can show that it is open. */
export function viewArtifact(key: string, artifact: Readonly<Ref<Artifact>>) {
	show({ type: "artifact", key, artifact });
}

/**
 * A document's Details, from its row's menu: `from` is the menu's button, as the menu item
 * that had focus is gone. The Details of another document take the panel's place.
 */
export function viewDocumentDetails(details: DocumentDetailsRequest, from: HTMLElement | null) {
	show({ type: "details", key: `details:${details.workspaceId}:${details.document.id}`, details }, from);
}

/**
 * Focus goes back to what opened the panel when it was lost with the panel (on the page, or
 * inside the panel), not when something else took it, such as a link that opened another chat.
 */
export function closePanel() {
	if (!current.value) return;
	current.value = null;
	const back = opener;
	opener = null;
	void nextTick(() => {
		const active = document.activeElement;
		const lost = !active || active === document.body || !active.isConnected || Boolean(active.closest("[data-slot=side-panel]"));
		if (lost && back?.isConnected) back.focus({ preventScroll: true });
	});
}

/** A file that is gone, such as a deleted document: the panel closes if it shows it. */
export function closeFile(url: string) {
	if (current.value?.type === "file" && current.value.file.url === url) closePanel();
}

/** A deleted document: the panel closes if it shows its Details. */
export function closeDocumentDetails(documentId: string) {
	if (current.value?.type === "details" && current.value.details.document.id === documentId) closePanel();
}

/** PDFs, CSV and TSV files, text, Markdown and JSON, and the image types that browsers show. Other files open as a link. */
export function canView(mediaType: string, name = "") {
	return fileKind(mediaType, name) !== null;
}

export function fileKind(mediaType: string, name = ""): "pdf" | "image" | "table" | "text" | null {
	if (mediaType === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
	if (/^image\/(png|jpe?g|gif|webp|avif)$/.test(mediaType)) return "image";
	if (/^text\/(csv|tab-separated-values)$/.test(mediaType) || /\.(csv|tsv)$/i.test(name)) return "table";
	if (/^(text\/(plain|markdown)|application\/json)$/.test(mediaType) || /\.(txt|md|json)$/i.test(name)) return "text";
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
