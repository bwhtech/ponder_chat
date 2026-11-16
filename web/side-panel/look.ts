import type { ArtifactKind } from "./panel";

/** Each kind's icon and colour, for the panel's header (header.ts), its stand-in (PanelPlaceholder.vue) and the card in the reply. */
export const ARTIFACT_LOOK: Record<ArtifactKind, { icon: string; ink: string; label: string }> = {
	document: { icon: "lucide-file-text", ink: "text-ink-blue-6", label: "Document" },
	slides: { icon: "lucide-presentation", ink: "text-ink-amber-6", label: "Slides" },
	html: { icon: "lucide-app-window", ink: "text-ink-violet-6", label: "Web page" },
};
export const FILE_LOOK = {
	pdf: { icon: "lucide-file-text", ink: "text-ink-red-6" },
	image: { icon: "lucide-image", ink: "text-ink-violet-6" },
	table: { icon: "lucide-file-spreadsheet", ink: "text-ink-green-6" },
};

/**
 * Set by the panel's stand-in once it has slid in, while the panel's code loaded, so the panel
 * that takes its place does not slide in again (SidePanel.vue).
 */
export const panelStandIn = { shown: false };
