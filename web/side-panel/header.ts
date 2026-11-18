import { slideCount, standaloneDeck } from "../artifacts/slides";
import { ARTIFACT_LOOK, FILE_LOOK } from "./look";
import { fileKind, type Artifact, type PanelItem, type ViewedFile } from "./panel";

/** What the panel's header shows for the item it holds: icon, title, a short detail and the download. */
export type PanelHeader = {
	title: string;
	/** The panel's name for screen readers: its title, or "Details of “notes.md”". */
	label: string;
	icon: string;
	ink: string;
	meta: string;
	copyLabel: string;
	download: { url: string; name: string } | null;
	/** Pages and slides sit on a gray ground; a document and a table on the page's own. */
	inset: boolean;
};

export function panelHeader(item: PanelItem | null, rows: number | null): PanelHeader {
	if (item?.type === "artifact") return artifactHeader(item.artifact.value);
	if (item?.type === "file") return fileHeader(item.file, rows);
	if (item?.type === "details") return detailsHeader(item.details.document.name, item.details.document.mediaType);
	return { title: "", label: "", icon: "", ink: "", meta: "", copyLabel: "", download: null, inset: false };
}

/** A workspace document's Details: its name and its file's icon, and "Details" beside them, so they are not taken for the file. */
function detailsHeader(name: string, mediaType: string): PanelHeader {
	return { title: name, label: `Details of “${name}”`, ...FILE_LOOK[fileKind(mediaType, name) ?? "text"], meta: "Details", copyLabel: "", download: null, inset: false };
}

/** For the card in the reply (artifacts/ArtifactPart.vue). */
export { ARTIFACT_LOOK };

function artifactHeader(artifact: Artifact): PanelHeader {
	const title = artifact.title || "Untitled";
	return {
		title,
		...ARTIFACT_LOOK[artifact.kind],
		// After the look, whose label is the kind's name ("Slides").
		label: title,
		meta: artifact.writing ? "Writing…" : artifactMeta(artifact),
		copyLabel: artifact.kind === "document" ? "Copy Markdown" : "Copy HTML",
		// Made only once the reply finished writing it, not on every streamed word.
		download: artifact.writing ? null : artifactFile(artifact, title),
		inset: artifact.kind === "slides",
	};
}

function artifactMeta(artifact: Artifact) {
	if (artifact.kind === "slides") return plural(slideCount(artifact.content), "slide");
	if (artifact.kind === "document") return plural(wordCount(artifact.content), "word");
	return "";
}

function artifactFile(artifact: Artifact, title: string) {
	const name = fileName(title);
	if (artifact.kind === "slides") return { url: dataUrl("text/html", standaloneDeck(artifact.content, title)), name: `${name}.html` };
	if (artifact.kind === "html") return { url: dataUrl("text/html", artifact.content), name: `${name}.html` };
	return { url: dataUrl("text/markdown", artifact.content), name: `${name}.md` };
}

function fileHeader(file: ViewedFile, rows: number | null): PanelHeader {
	const kind = fileKind(file.mediaType, file.name);
	return {
		title: file.name,
		label: file.name,
		...FILE_LOOK[kind ?? "image"],
		meta: kind === "table" && rows !== null ? plural(rows, "row") : "",
		copyLabel: "",
		download: { url: file.url, name: file.name },
		inset: kind === "pdf",
	};
}

function plural(count: number, noun: string) {
	return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

function wordCount(text: string) {
	return text.split(/\s+/).filter((word) => /\w/.test(word)).length;
}

/** A name a file system accepts, from the artifact's title. */
function fileName(title: string) {
	return title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "artifact";
}

function dataUrl(type: string, text: string) {
	return `data:${type};charset=utf-8,${encodeURIComponent(text)}`;
}
