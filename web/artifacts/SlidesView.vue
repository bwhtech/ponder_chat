<script setup lang="ts">
import { Skeleton } from "frappe-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { Artifact } from "../side-panel/panel";
import { finishedSlides, framedDeck, SLIDE_GAP, SLIDE_HEIGHT, SLIDE_WIDTH, slideCount } from "./slides";
import { artifactSteps, currentStepText } from "./steps";

/**
 * A slide deck in the panel, every slide in one column. The frame is drawn at the slides'
 * own size and scaled to the panel's width, so the deck looks the same at any width.
 * While the reply writes it, a slide shows once it is finished.
 */
const props = defineProps<{ artifact: Artifact }>();

const html = computed(() => (props.artifact.writing ? finishedSlides(props.artifact.content) : props.artifact.content));
const count = computed(() => slideCount(html.value));
// A new page for the frame only when a slide is added, not on every streamed word.
const page = computed(() => framedDeck(html.value));
// "Writing slide 4…" or "Setting up the look…" on the placeholder for the slide on its way.
const writingText = computed(() => currentStepText("slides", artifactSteps("slides", props.artifact.content, false)));
const frameHeight = computed(() => count.value * SLIDE_HEIGHT + Math.max(0, count.value - 1) * SLIDE_GAP);

const column = ref<HTMLElement | null>(null);
const scale = ref(0);
let observer: ResizeObserver | undefined;

onMounted(() => {
	observer = new ResizeObserver(([entry]) => (scale.value = (entry?.contentRect.width ?? 0) / SLIDE_WIDTH));
	if (column.value) observer.observe(column.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
	<div ref="column" class="flex flex-col gap-4">
		<div
			v-if="count && scale"
			class="relative overflow-hidden"
			:style="{ height: `${frameHeight * scale}px` }"
		>
			<iframe
				:srcdoc="page"
				sandbox=""
				referrerpolicy="no-referrer"
				:title="artifact.title"
				class="absolute left-0 top-0 origin-top-left border-0"
				:style="{ width: `${SLIDE_WIDTH}px`, height: `${frameHeight}px`, transform: `scale(${scale})` }"
			/>
		</div>
		<div v-if="artifact.writing" class="relative aspect-video w-full overflow-hidden rounded-4">
			<Skeleton class="absolute inset-0 !rounded-[inherit]" />
			<p class="absolute inset-0 flex items-center justify-center text-sm text-ink-gray-5">{{ writingText }}</p>
		</div>
		<p v-else-if="!count" class="pt-[20vh] text-center text-base text-ink-gray-6">This deck has no slides.</p>
	</div>
</template>
