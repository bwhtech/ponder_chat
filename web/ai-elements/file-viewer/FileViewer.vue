<script setup lang="ts">
import { defineAsyncComponent, nextTick, ref, watch } from "vue";
import { closeViewer, isPdf, viewedFile } from "./viewer";

/**
 * Shows a PDF or an image over the app, as a mail app does. Mount it once.
 * pdf.js is loaded the first time a PDF opens, not with the app.
 */
const PdfPages = defineAsyncComponent(() => import("./PdfPages.vue"));

const dialog = ref<HTMLDialogElement>();

watch(viewedFile, async (file) => {
	await nextTick();
	if (file && !dialog.value?.open) dialog.value?.showModal();
	if (!file && dialog.value?.open) dialog.value.close();
});

/** A click on the dark area around the file closes the viewer. */
function onBackdropClick(event: MouseEvent) {
	if (event.target === event.currentTarget) closeViewer();
}
</script>

<template>
	<dialog
		ref="dialog"
		data-slot="file-viewer"
		class="file-viewer fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none bg-transparent p-0 text-white outline-none"
		:aria-label="viewedFile?.name"
		@close="closeViewer"
	>
		<div v-if="viewedFile" class="flex h-full flex-col">
			<header class="flex shrink-0 items-center gap-2 px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] sm:px-4">
				<p class="min-w-0 flex-1 truncate text-base-medium text-white/90" :title="viewedFile.name">{{ viewedFile.name }}</p>
				<a
					:href="viewedFile.url"
					:download="viewedFile.name"
					class="viewer-button"
					:aria-label="`Download ${viewedFile.name}`"
					title="Download"
				>
					<span class="lucide-download size-4" aria-hidden="true" />
				</a>
				<a :href="viewedFile.url" target="_blank" rel="noreferrer noopener" class="viewer-button" aria-label="Open in a new tab" title="Open in a new tab">
					<span class="lucide-external-link size-4" aria-hidden="true" />
				</a>
				<button type="button" class="viewer-button" aria-label="Close" title="Close (Esc)" @click="closeViewer">
					<span class="lucide-x size-4" aria-hidden="true" />
				</button>
			</header>
			<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain" @click="onBackdropClick">
				<PdfPages v-if="isPdf(viewedFile.mediaType, viewedFile.name)" :key="viewedFile.url" :url="viewedFile.url" :name="viewedFile.name" @click="onBackdropClick" />
				<div v-else class="flex min-h-full items-center justify-center p-4 pt-0 sm:p-8 sm:pt-0" @click="onBackdropClick">
					<img :src="viewedFile.url" :alt="viewedFile.name" class="max-h-[calc(100dvh-6rem)] max-w-full rounded-4 object-contain shadow-2xl" />
				</div>
			</div>
		</div>
	</dialog>
</template>

<style scoped>
.file-viewer::backdrop {
	background: rgb(0 0 0 / 0.88);
}

.file-viewer[open],
.file-viewer[open]::backdrop {
	animation: viewer-in 180ms var(--ease-out-strong, ease-out);
}

@keyframes viewer-in {
	from {
		opacity: 0;
	}
}

.viewer-button {
	display: flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	width: 2rem;
	height: 2rem;
	border-radius: 9999px;
	color: rgb(255 255 255 / 0.8);
	transition:
		background-color 150ms ease,
		transform 150ms var(--ease-out-strong, ease-out);
}

.viewer-button:active {
	transform: scale(0.95);
}

@media (prefers-reduced-motion: reduce) {
	.viewer-button:active {
		transform: none;
	}
}

@media (hover: hover) and (pointer: fine) {
	.viewer-button:hover {
		background: rgb(255 255 255 / 0.12);
		color: white;
	}
}

.viewer-button:focus-visible {
	outline: 2px solid rgb(255 255 255 / 0.7);
	outline-offset: 1px;
}
</style>
