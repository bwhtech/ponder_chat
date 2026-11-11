import { DocumentTextIcon, PhotoIcon, PresentationChartBarIcon, TableCellsIcon, WindowIcon } from "@heroicons/react/24/outline";
import type { IconProps } from "@astryxdesign/core/Icon";
import { slideCount, standaloneDeck } from "../artifacts/slides";
import { fileKind, type Artifact, type ArtifactKind, type PanelItem, type ViewedFile } from "./panel";

/** What the panel's header shows for the item it holds: icon, title, a short detail and the download. */
export type PanelHeader = {
	title: string;
	look: Look;
	meta: string;
	copyLabel: string;
	/** Made when the person clicks Download, not on every streamed word. */
	download: (() => { url: string; name: string }) | null;
	/** Pages and slides sit on a muted ground; a document and a table on the page's own. */
	inset: boolean;
};

export type Look = { icon: typeof DocumentTextIcon; color: IconProps["color"] };

export function panelHeader(item: PanelItem | null, rows: number | null): PanelHeader | null {
	if (item?.type === "artifact") return artifactHeader(item.artifact);
	if (item?.type === "file") return fileHeader(item.file, rows);
	return null;
}

/** Each kind's icon and colour, for the panel's header and the card in the reply. */
export const ARTIFACT_LOOK: Record<ArtifactKind, Look & { label: string }> = {
	document: { icon: DocumentTextIcon, color: "blue", label: "Document" },
	slides: { icon: PresentationChartBarIcon, color: "orange", label: "Slides" },
	html: { icon: WindowIcon, color: "purple", label: "Web page" },
};

function artifactHeader(artifact: Artifact): PanelHeader {
	const title = artifact.title || "Untitled";
	return {
		title,
		look: ARTIFACT_LOOK[artifact.kind],
		meta: artifact.writing ? "Writing…" : artifactMeta(artifact),
		copyLabel: artifact.kind === "document" ? "Copy Markdown" : "Copy HTML",
		// Only once the reply finished writing it.
		download: artifact.writing ? null : () => artifactFile(artifact, title),
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
	if (artifact.kind === "slides") return { url: blobUrl("text/html", standaloneDeck(artifact.content, title)), name: `${name}.html` };
	if (artifact.kind === "html") return { url: blobUrl("text/html", artifact.content), name: `${name}.html` };
	return { url: blobUrl("text/markdown", artifact.content), name: `${name}.md` };
}

const FILE_LOOK: Record<"pdf" | "image" | "table", Look> = {
	pdf: { icon: DocumentTextIcon, color: "red" },
	image: { icon: PhotoIcon, color: "purple" },
	table: { icon: TableCellsIcon, color: "green" },
};

function fileHeader(file: ViewedFile, rows: number | null): PanelHeader {
	const kind = fileKind(file.mediaType, file.name);
	return {
		title: file.name,
		look: FILE_LOOK[kind ?? "image"],
		meta: kind === "table" && rows !== null ? plural(rows, "row") : "",
		copyLabel: "",
		download: () => ({ url: file.url, name: file.name }),
		inset: kind === "pdf",
	};
}

/** Saves a file under `name`, as a link with a download attribute would. */
export function saveFile({ url, name }: { url: string; name: string }) {
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	if (url.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(url), 60_000);
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

function blobUrl(type: string, text: string) {
	return URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
}
