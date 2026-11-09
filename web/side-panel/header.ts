import { slideCount, standaloneDeck } from "../artifacts/slides";
import { fileKind, type Artifact, type PanelItem, type ViewedFile } from "./panel";

/** What the panel's header shows for the item it holds: icon, title, a short detail and the download. */
export type PanelHeader = {
	title: string;
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
	return { title: "", icon: "", ink: "", meta: "", copyLabel: "", download: null, inset: false };
}

function artifactHeader(artifact: Artifact): PanelHeader {
	const slides = artifact.kind === "slides";
	const title = artifact.title || "Untitled";
	return {
		title,
		icon: slides ? "lucide-presentation" : "lucide-file-text",
		ink: slides ? "text-ink-amber-6" : "text-ink-blue-6",
		meta: artifact.writing ? "Writing…" : slides ? plural(slideCount(artifact.content), "slide") : plural(wordCount(artifact.content), "word"),
		copyLabel: slides ? "Copy HTML" : "Copy Markdown",
		// Made only once the reply finished writing it, not on every streamed word.
		download: artifact.writing
			? null
			: slides
				? { url: dataUrl("text/html", standaloneDeck(artifact.content, title)), name: `${fileName(title)}.html` }
				: { url: dataUrl("text/markdown", artifact.content), name: `${fileName(title)}.md` },
		inset: slides,
	};
}

function fileHeader(file: ViewedFile, rows: number | null): PanelHeader {
	const kind = fileKind(file.mediaType, file.name);
	const look = {
		pdf: { icon: "lucide-file-text", ink: "text-ink-red-6" },
		image: { icon: "lucide-image", ink: "text-ink-violet-6" },
		table: { icon: "lucide-file-spreadsheet", ink: "text-ink-green-6" },
	}[kind ?? "image"];
	return {
		title: file.name,
		...look,
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
