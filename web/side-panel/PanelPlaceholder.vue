<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import TablePlaceholder from "./TablePlaceholder.vue";
import TextColumn from "./TextColumn.vue";
import TextLines from "./TextLines.vue";
import { computed, onMounted } from "vue";
import { ARTIFACT_LOOK, FILE_LOOK, panelStandIn } from "./look";
import PdfPagesPlaceholder from "./PdfPagesPlaceholder.vue";
import { closePanel, fileKind, panelItem } from "./panel";
import DocumentDetailsPlaceholder from "../workspaces/DocumentDetailsPlaceholder.vue";
import "./slide.css";

/**
 * The side panel (SidePanel.vue) while its code arrives: the same panel, sliding in the same
 * way, with the file's or the artifact's icon and title, Close, and lines where the content
 * goes. The buttons that act on the content come with the panel, at the header's far end;
 * a document's Details draw their Log button, off, so the title does not move. Each kind's
 * skeleton sits where the viewer that follows draws its own (a PDF's page, a table's rows,
 * the text column, a slide, the Details' summary), so nothing moves when it arrives.
 */
defineOptions({ inheritAttrs: false });
const header = computed(() => {
	const item = panelItem.value;
	if (item?.type === "artifact") {
		const artifact = item.artifact.value;
		// The look's label is the kind's name ("Slides"): the panel's is the title.
		return { title: artifact.title || "Untitled", meta: "", ...ARTIFACT_LOOK[artifact.kind], label: artifact.title || "Untitled", inset: artifact.kind === "slides", kind: artifact.kind };
	}
	if (item?.type === "details") {
		// As header.ts draws a document's Details, with Log beside Close.
		const { name, mediaType } = item.details.document;
		return { title: name, label: `Details of “${name}”`, meta: "Details", ...FILE_LOOK[fileKind(mediaType, name) ?? "text"], inset: false, kind: "details" as const };
	}
	const kind = item ? fileKind(item.file.mediaType, item.file.name) : null;
	return { title: item?.file.name ?? "", label: item?.file.name ?? "", meta: "", ...FILE_LOOK[kind ?? "image"], inset: kind === "pdf", kind };
});
onMounted(() => (panelStandIn.shown = true));
</script>

<template>
	<Transition name="side-panel" appear>
		<aside
			v-if="panelItem"
			data-slot="side-panel"
			:aria-label="header.label"
			aria-busy="true"
			class="fixed inset-0 z-30 flex flex-col bg-surface-base pt-[env(safe-area-inset-top)] lg:static lg:z-auto lg:w-[clamp(380px,46vw,880px)] lg:shrink-0 lg:border-l lg:border-outline-gray-1 lg:pt-0"
		>
			<header class="flex min-h-12 shrink-0 items-center gap-2 border-b border-outline-gray-1 pl-4 pr-2 sm:pl-5">
				<span :class="[header.icon, header.ink, 'size-4 shrink-0']" aria-hidden="true" />
				<h2 class="min-w-0 truncate text-base-medium text-ink-gray-9" :title="header.title">{{ header.title }}</h2>
				<span v-if="header.meta" class="shrink-0 whitespace-nowrap text-sm text-ink-gray-5">{{ header.meta }}</span>
				<div class="ml-auto flex shrink-0 items-center gap-0.5 pl-2 [@media(pointer:coarse)]:gap-4">
					<Button v-if="header.kind === 'details'" variant="ghost" icon-left="lucide-scroll-text" label="Log" class="touch-target mr-1" disabled />
					<Button variant="ghost" icon="lucide-x" aria-label="Close" class="touch-target" @click="closePanel" />
				</div>
			</header>
			<div class="min-h-0 flex-1 overflow-hidden" :class="header.inset ? 'bg-surface-gray-1' : ''">
				<DocumentDetailsPlaceholder v-if="header.kind === 'details'" />
				<PdfPagesPlaceholder v-else-if="header.kind === 'pdf'" />
				<TablePlaceholder v-else-if="header.kind === 'table'" />
				<TextColumn v-else-if="header.kind === 'text' || header.kind === 'document'"><TextLines /></TextColumn>
				<div v-else-if="header.kind === 'slides'" class="p-4 sm:p-6"><Skeleton class="aspect-video w-full rounded-4" /></div>
				<!-- An image appears centred and a web page fills the panel: neither has a skeleton, so lines would only flash. -->
			</div>
		</aside>
	</Transition>
</template>
