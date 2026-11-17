<script setup lang="ts">
import { Button } from "frappe-ui";
import TablePlaceholder from "./TablePlaceholder.vue";
import TextLines from "./TextLines.vue";
import { computed, onMounted } from "vue";
import { ARTIFACT_LOOK, FILE_LOOK, panelStandIn } from "./look";
import PdfPagesPlaceholder from "./PdfPagesPlaceholder.vue";
import { closePanel, fileKind, panelItem } from "./panel";
import "./slide.css";

/**
 * The side panel (SidePanel.vue) while its code arrives: the same panel, sliding in the same
 * way, with the file's or the artifact's icon and title, Close, and lines where the content
 * goes. The buttons that act on the content come with the panel, at the header's far end.
 * The lines sit where the viewer that follows draws its own (a PDF's page, TextView's column),
 * so nothing moves when it arrives.
 */
defineOptions({ inheritAttrs: false });
const header = computed(() => {
	const item = panelItem.value;
	if (item?.type === "artifact") {
		const artifact = item.artifact.value;
		return { title: artifact.title || "Untitled", ...ARTIFACT_LOOK[artifact.kind], inset: artifact.kind === "slides", kind: null };
	}
	const kind = item ? fileKind(item.file.mediaType, item.file.name) : null;
	return { title: item?.file.name ?? "", ...FILE_LOOK[kind ?? "image"], inset: kind === "pdf", kind };
});
onMounted(() => (panelStandIn.shown = true));
</script>

<template>
	<Transition name="side-panel" appear>
		<aside
			v-if="panelItem"
			data-slot="side-panel"
			:aria-label="header.title"
			aria-busy="true"
			class="fixed inset-0 z-30 flex flex-col bg-surface-base pt-[env(safe-area-inset-top)] lg:static lg:z-auto lg:w-[clamp(380px,46vw,880px)] lg:shrink-0 lg:border-l lg:border-outline-gray-1 lg:pt-0"
		>
			<header class="flex min-h-12 shrink-0 items-center gap-2 border-b border-outline-gray-1 pl-4 pr-2 sm:pl-5">
				<span :class="[header.icon, header.ink, 'size-4 shrink-0']" aria-hidden="true" />
				<h2 class="min-w-0 truncate text-base-medium text-ink-gray-9" :title="header.title">{{ header.title }}</h2>
				<div class="ml-auto flex shrink-0 items-center gap-0.5 pl-2 [@media(pointer:coarse)]:gap-4">
					<Button variant="ghost" icon="lucide-x" aria-label="Close" class="touch-target" @click="closePanel" />
				</div>
			</header>
			<div class="min-h-0 flex-1 overflow-hidden" :class="header.inset ? 'bg-surface-gray-1' : ''">
				<PdfPagesPlaceholder v-if="header.kind === 'pdf'" />
				<TablePlaceholder v-else-if="header.kind === 'table'" />
				<div v-else-if="header.kind === 'text'" class="mx-auto w-full max-w-[680px] px-5 pt-8 sm:px-10 sm:pt-10"><TextLines /></div>
				<!-- An image has no skeleton of its own: it appears centred, so lines would only flash. -->
				<div v-else-if="header.kind !== 'image'" class="p-4 sm:p-6"><TextLines /></div>
			</div>
		</aside>
	</Transition>
</template>
