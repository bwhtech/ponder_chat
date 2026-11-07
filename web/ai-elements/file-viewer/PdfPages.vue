<script setup lang="ts">
import { Skeleton } from "frappe-ui";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";

/**
 * Every page of a PDF in one column that scrolls. A page draws when it comes
 * near the screen, so a long PDF does not draw all its pages at once.
 * This file and pdf.js load only when the viewer first opens a PDF.
 */
const props = defineProps<{ url: string; name: string }>();

GlobalWorkerOptions.workerSrc = workerUrl;

/** `tries` counts failed draws: a page gets one more try, then shows that it failed. */
type Page = { number: number; ratio: number; drawn: boolean; tries: number; failed: boolean };

const pages = ref<Page[]>([]);
const failed = ref(false);
const pdf = shallowRef<PDFDocumentProxy>();
const task = getDocument({ url: props.url });
const drawing = new Set<number>();
let observer: IntersectionObserver | undefined;
let unmounted = false;

onMounted(async () => {
	try {
		const document = await task.promise;
		const first = (await document.getPage(1)).getViewport({ scale: 1 });
		// The viewer closed while the PDF loaded: watch nothing.
		if (unmounted) return;
		pdf.value = document;
		// Until a page draws, it has the shape of the first page.
		pages.value = Array.from({ length: document.numPages }, (_, index) => ({
			number: index + 1,
			ratio: first.width / first.height,
			drawn: false,
			tries: 0,
			failed: false,
		}));
		observer = new IntersectionObserver(onVisible, { rootMargin: "100% 0px" });
	} catch {
		if (!unmounted) failed.value = true;
	}
});

onBeforeUnmount(() => {
	unmounted = true;
	observer?.disconnect();
	observer = undefined;
	void task.destroy();
});

/** Called by each page element as it mounts, so the observer can watch it. */
function watchPage(element: unknown) {
	if (element instanceof HTMLElement && observer) observer.observe(element);
}

function onVisible(entries: IntersectionObserverEntry[]) {
	for (const entry of entries) {
		if (!entry.isIntersecting) continue;
		const target = entry.target as HTMLElement;
		observer?.unobserve(target);
		const number = Number(target.dataset.page);
		const page = pages.value[number - 1];
		if (page && !page.drawn && !page.failed) void draw(number, target);
	}
}

async function draw(number: number, element: HTMLElement) {
	const document = pdf.value;
	const canvas = element.querySelector("canvas");
	if (!document || !canvas || drawing.has(number)) return;
	drawing.add(number);
	try {
		const page = await document.getPage(number);
		const base = page.getViewport({ scale: 1 });
		// Sharp on high-density screens: draw at the element's width in device pixels.
		const scale = (element.clientWidth * Math.min(window.devicePixelRatio || 1, 2)) / base.width;
		const viewport = page.getViewport({ scale });
		canvas.width = Math.floor(viewport.width);
		canvas.height = Math.floor(viewport.height);
		await page.render({ canvas, viewport }).promise;
		const entry = pages.value[number - 1];
		if (entry) Object.assign(entry, { ratio: base.width / base.height, drawn: true });
	} catch {
		// The others still show. Watch the page again for one more try, then show it failed.
		const entry = pages.value[number - 1];
		if (entry && ++entry.tries < 2) observer?.observe(element);
		else if (entry) entry.failed = true;
	} finally {
		drawing.delete(number);
	}
}
</script>

<template>
	<div data-slot="pdf-pages" class="flex min-h-full flex-col items-center gap-3 px-3 pb-8 sm:px-8" aria-live="polite">
		<div v-if="failed" class="mt-[20vh] flex flex-col items-center gap-3 text-center">
			<p class="text-base text-white/80">This PDF could not be shown.</p>
			<a :href="url" :download="name" class="text-sm-medium text-white underline underline-offset-2">Download it</a>
		</div>
		<template v-else-if="pages.length">
			<div
				v-for="page in pages"
				:key="page.number"
				:ref="watchPage"
				:data-page="page.number"
				class="relative w-full max-w-[860px] overflow-hidden rounded-2 bg-white shadow-2xl"
				:style="{ aspectRatio: page.ratio }"
				:aria-label="`Page ${page.number} of ${pages.length}`"
				role="img"
			>
				<canvas class="block size-full" />
				<div v-if="page.failed" class="absolute inset-0 flex items-center justify-center bg-gray-100 p-4 text-center text-base text-gray-600">
					Page {{ page.number }} could not be shown.
				</div>
				<Skeleton v-else-if="!page.drawn" class="absolute inset-0 !bg-gray-100" />
			</div>
		</template>
		<!-- Loading: a page-shaped placeholder. -->
		<Skeleton v-else class="aspect-[1/1.414] w-full max-w-[860px] rounded-2 !bg-white/10" />
	</div>
</template>
