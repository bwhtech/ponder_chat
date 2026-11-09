<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { Artifact } from "../side-panel/panel";
import { presentedDeck, SLIDE_HEIGHT, SLIDE_WIDTH, slideCount } from "./slides";

/**
 * A deck full screen, one slide at a time. The frame holds every slide and moves to show
 * the current one, so a slide change does not reload it. Arrow keys, Space, Page Up/Down
 * or a click move; Escape leaves. Where the browser has no full screen (iPhone), it covers the page.
 */
const props = defineProps<{ artifact: Artifact }>();
const emit = defineEmits<{ close: [] }>();

const root = ref<HTMLElement | null>(null);
const page = presentedDeck(props.artifact.content);
const count = slideCount(props.artifact.content);
const index = ref(0);
const viewport = ref({ width: innerWidth, height: innerHeight });
const scale = computed(() => Math.min(viewport.value.width / SLIDE_WIDTH, viewport.value.height / SLIDE_HEIGHT));

/** The controls show while the pointer moves, then fade so the slide is all that shows. */
const controls = ref(true);
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function showControls() {
	controls.value = true;
	clearTimeout(hideTimer);
	hideTimer = setTimeout(() => (controls.value = false), 2000);
}

function go(to: number) {
	index.value = Math.min(Math.max(0, to), count - 1);
}

function onKeydown(event: KeyboardEvent) {
	const moves: Record<string, number> = {
		ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, Enter: 1,
		ArrowLeft: -1, ArrowUp: -1, PageUp: -1, Backspace: -1,
	};
	if (event.key === "Escape") leave();
	else if (event.key === "Home") go(0);
	else if (event.key === "End") go(count - 1);
	else if (event.key in moves) go(index.value + moves[event.key]!);
	else return;
	// The slides own these keys: the chat behind must not get them (Enter would send a message).
	event.preventDefault();
	event.stopPropagation();
}

/** A click on the left third goes back; anywhere else goes on. */
function onClick(event: MouseEvent) {
	go(index.value + (event.clientX < innerWidth / 3 ? -1 : 1));
}

function onResize() {
	viewport.value = { width: innerWidth, height: innerHeight };
}

/** Leaving full screen with the browser's own key also leaves present mode. */
function onFullscreenChange() {
	if (!document.fullscreenElement) emit("close");
}

function leave() {
	if (document.fullscreenElement) void document.exitFullscreen();
	else emit("close");
}

onMounted(() => {
	(document.activeElement as HTMLElement | null)?.blur();
	addEventListener("keydown", onKeydown, { capture: true });
	addEventListener("resize", onResize);
	showControls();
	root.value
		?.requestFullscreen?.()
		.then(() => document.addEventListener("fullscreenchange", onFullscreenChange))
		.catch(() => undefined);
});

onBeforeUnmount(() => {
	removeEventListener("keydown", onKeydown, { capture: true });
	removeEventListener("resize", onResize);
	document.removeEventListener("fullscreenchange", onFullscreenChange);
	clearTimeout(hideTimer);
	if (document.fullscreenElement) void document.exitFullscreen();
});
</script>

<template>
	<Teleport to="body">
	<div
		ref="root"
		data-slot="present-mode"
		role="dialog"
		aria-modal="true"
		:aria-label="`${artifact.title}, slide ${index + 1} of ${count}`"
		class="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black"
		:class="{ 'cursor-none': !controls }"
		@pointermove="showControls"
		@click="onClick"
	>
		<div class="relative shrink-0 overflow-hidden" :style="{ width: `${SLIDE_WIDTH * scale}px`, height: `${SLIDE_HEIGHT * scale}px` }">
			<iframe
				:srcdoc="page"
				sandbox=""
				referrerpolicy="no-referrer"
				tabindex="-1"
				:title="artifact.title"
				class="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
				:style="{
					width: `${SLIDE_WIDTH}px`,
					height: `${SLIDE_HEIGHT * count}px`,
					transform: `scale(${scale}) translateY(${-index * SLIDE_HEIGHT}px)`,
				}"
			/>
		</div>
		<div
			class="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-[rgb(38_38_38/0.92)] p-1 text-white/90 shadow-lg ring-1 ring-white/10 transition-opacity duration-300"
			:class="controls ? 'opacity-100' : 'pointer-events-none opacity-0'"
			@click.stop
		>
			<button type="button" class="present-button" aria-label="Previous slide" :disabled="index === 0" @click="go(index - 1)">
				<span class="lucide-chevron-left size-4" aria-hidden="true" />
			</button>
			<span class="min-w-14 text-center text-sm tabular-nums" aria-live="polite">{{ index + 1 }} / {{ count }}</span>
			<button type="button" class="present-button" aria-label="Next slide" :disabled="index === count - 1" @click="go(index + 1)">
				<span class="lucide-chevron-right size-4" aria-hidden="true" />
			</button>
			<button type="button" class="present-button" aria-label="Leave present mode" title="Leave (Esc)" @click="leave">
				<span class="lucide-x size-4" aria-hidden="true" />
			</button>
		</div>
	</div>
	</Teleport>
</template>

<style scoped>
.present-button {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 2rem;
	height: 2rem;
	border-radius: 9999px;
	transition: background-color 150ms ease;
}
.present-button:hover:not(:disabled) {
	background: rgb(255 255 255 / 0.15);
}
.present-button:disabled {
	opacity: 0.35;
}
.present-button:focus-visible {
	outline: 2px solid rgb(255 255 255 / 0.7);
	outline-offset: 1px;
}
@media (pointer: coarse) {
	.present-button {
		width: 2.75rem;
		height: 2.75rem;
	}
}
</style>
