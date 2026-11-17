<script setup lang="ts">
import { Button, TabButtons } from "frappe-ui";
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from "vue";
import DocumentView from "../artifacts/DocumentView.vue";
import HtmlView from "../artifacts/HtmlView.vue";
import PresentMode from "../artifacts/PresentMode.vue";
import SlidesView from "../artifacts/SlidesView.vue";
import { slideCount } from "../artifacts/slides";
import { panelHeader } from "./header";
import { panelStandIn } from "./look";
import { closePanel, fileKind, panelItem } from "./panel";
import PdfPagesPlaceholder from "./PdfPagesPlaceholder.vue";
import TableView from "./TableView.vue";
import TextView from "./TextView.vue";
import "./slide.css";

/**
 * The panel at the right of the chat, for a file or an artifact. On a wide screen it sits
 * beside the chat; on a narrower one it covers the page. Mount it once, in the shell's row.
 * pdf.js loads the first time a PDF opens, not with the app. The first time, the panel slides
 * in, unless its stand-in (PanelPlaceholder.vue) already has while this code loaded. While
 * pdf.js loads, a page-shaped skeleton shows at once (no delay).
 */
const PdfPages = defineAsyncComponent({ loader: () => import("./PdfPages.vue"), loadingComponent: PdfPagesPlaceholder, delay: 0 });

const item = panelItem;
const artifact = computed(() => (item.value?.type === "artifact" ? item.value.artifact.value : null));
const file = computed(() => (item.value?.type === "file" ? item.value.file : null));
const kind = computed(() => (file.value ? fileKind(file.value.mediaType, file.value.name) : null));
const rows = ref<number | null>(null);
const presenting = ref(false);
// A web page shows its preview or its code. While the reply writes it, only the code.
const pageView = ref<"preview" | "code">("preview");
const pageViews = [
	{ value: "preview", label: "Preview" },
	{ value: "code", label: "Code" },
];
// Below lg the panel covers the page, and the page behind it is inert (Shell.vue): focus moves
// into the panel, so the keyboard and screen readers start there. Beside the chat it stays put.
const aside = ref<HTMLElement>();
const covers = matchMedia("(max-width: 1023.98px)");
watch(
	() => Boolean(item.value),
	(open) => open && covers.matches && void nextTick(() => aside.value?.focus({ preventScroll: true })),
	{ immediate: true },
);
watch(item, () => {
	rows.value = null;
	presenting.value = false;
	pageView.value = "preview";
});
const canPresent = computed(() => artifact.value?.kind === "slides" && !artifact.value.writing && slideCount(artifact.value.content) > 0);

const header = computed(() => panelHeader(item.value, rows.value));
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
	if (!artifact.value) return;
	await navigator.clipboard.writeText(artifact.value.content).catch(() => undefined);
	copied.value = true;
	clearTimeout(copiedTimer);
	copiedTimer = setTimeout(() => (copied.value = false), 2000);
}

/** Escape closes the panel, unless something else uses the key: a field, a menu or a dialog. */
function onKeydown(event: KeyboardEvent) {
	if (event.key !== "Escape" || event.defaultPrevented || !item.value || presenting.value) return;
	const target = event.target as HTMLElement | null;
	if (target?.closest("input, textarea, select, [contenteditable], dialog, [role=dialog], [role=menu]")) return;
	closePanel();
}
// Immediate: the panel's code first loads after its first item is set.
watch(item, (open) => (open ? addEventListener("keydown", onKeydown) : removeEventListener("keydown", onKeydown)), { immediate: true });
onBeforeUnmount(() => {
	removeEventListener("keydown", onKeydown);
	clearTimeout(copiedTimer);
});
</script>

<template>
	<Transition name="side-panel" :appear="!panelStandIn.shown">
		<aside
			v-if="item"
			ref="aside"
			data-slot="side-panel"
			:aria-label="header.title"
			tabindex="-1"
			class="outline-none fixed inset-0 z-30 flex flex-col bg-surface-base pt-[env(safe-area-inset-top)] lg:static lg:z-auto lg:w-[clamp(380px,46vw,880px)] lg:shrink-0 lg:border-l lg:border-outline-gray-1 lg:pt-0"
		>
			<header class="flex min-h-12 shrink-0 items-center gap-2 border-b border-outline-gray-1 pl-4 pr-2 sm:pl-5">
				<span :class="[header.icon, header.ink, 'size-4 shrink-0']" aria-hidden="true" />
				<h2 class="min-w-0 truncate text-base-medium text-ink-gray-9" :title="header.title">{{ header.title }}</h2>
				<span v-if="header.meta" class="shrink-0 whitespace-nowrap text-sm text-ink-gray-5">{{ header.meta }}</span>
				<div class="ml-auto flex shrink-0 items-center gap-0.5 pl-2 [@media(pointer:coarse)]:gap-4">
					<TabButtons v-if="artifact?.kind === 'html' && !artifact.writing" v-model="pageView" :options="pageViews" class="mr-1" />
					<Button v-if="canPresent" variant="ghost" icon-left="lucide-play" label="Present" class="mr-1" @click="presenting = true" />
					<Button v-if="artifact" variant="ghost" :icon="copied ? 'lucide-check' : 'lucide-copy'" :tooltip="copied ? 'Copied' : header.copyLabel" :aria-label="header.copyLabel" :disabled="artifact.writing" class="touch-target" @click="copy" />
					<a v-if="header.download" :href="header.download.url" :download="header.download.name" :aria-label="`Download ${header.download.name}`" title="Download" class="panel-icon touch-target">
						<span class="lucide-download size-4" aria-hidden="true" />
					</a>
					<a v-if="file" :href="file.url" target="_blank" rel="noreferrer noopener" aria-label="Open in a new tab" title="Open in a new tab" class="panel-icon touch-target">
						<span class="lucide-external-link size-4" aria-hidden="true" />
					</a>
					<Button variant="ghost" icon="lucide-x" tooltip="Close (Esc)" aria-label="Close" class="touch-target" @click="closePanel" />
				</div>
			</header>

			<div :key="item.key" class="min-h-0 flex-1 overflow-auto overscroll-contain" :class="header.inset ? 'bg-surface-gray-1' : ''">
				<DocumentView v-if="artifact?.kind === 'document'" :artifact="artifact" />
				<SlidesView v-else-if="artifact?.kind === 'slides'" :artifact="artifact" class="p-4 sm:p-6" />
				<HtmlView v-else-if="artifact" :artifact="artifact" :view="pageView" />
				<PdfPages v-else-if="file && kind === 'pdf'" :url="file.url" :name="file.name" />
				<TableView v-else-if="file && kind === 'table'" :url="file.url" :name="file.name" :media-type="file.mediaType" @rows="rows = $event" />
				<TextView v-else-if="file && kind === 'text'" :url="file.url" :name="file.name" :media-type="file.mediaType" />
				<div v-else-if="file" class="flex min-h-full items-center justify-center p-4 sm:p-6">
					<img :src="file.url" :alt="file.name" class="max-h-[calc(100dvh-7rem)] max-w-full rounded-4 object-contain" />
				</div>
			</div>
			<PresentMode v-if="presenting && artifact" :artifact="artifact" @close="presenting = false" />
		</aside>
	</Transition>
</template>

<style scoped>
/* A link styled as frappe-ui's ghost icon Button, for downloads, which need a real link. */
.panel-icon {
	display: flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	width: 1.75rem;
	height: 1.75rem;
	border-radius: 0.5rem;
	color: var(--ink-gray-7);
	transition: background-color 150ms ease;
}
.panel-icon:hover {
	background: var(--surface-gray-3);
}
.panel-icon:active {
	background: var(--surface-gray-4);
}
.panel-icon:focus-visible {
	outline: none;
	box-shadow: 0 0 0 2px var(--outline-gray-3);
}
</style>
