<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { count } from "../numbers";
import { DOCUMENT_TYPES } from "./documents";
import { useFileDrop } from "./file-drop";
import type { SetupStep } from "./onboarding";
import { pickedFiles } from "./upload";
import WorkspaceSetupCard from "./WorkspaceSetupCard.vue";

/**
 * "Set up <name>": a card for each step still to do, over the workspace's sections, for a
 * person who can edit it (WorkspaceOnboarding.vue). Each card's button opens what the page
 * opens elsewhere: the instructions dialog, the file picker, Share. A done step's card leaves
 * (the others slide into its place), and the bar fills. The Documents card stays while its
 * files go up. Files picked, or dropped on the cards, go to `upload`, which
 * WorkspaceOnboarding.vue does, with `uploading`.
 *
 * Three cards side by side from Tailwind's sm, two when the workspace started with two to do
 * (an organisation one, or an editor who can't share). On a phone they scroll sideways.
 */
const props = defineProps<{ name: string; steps: SetupStep[]; uploading: number }>();
const emit = defineEmits<{ instructions: []; share: []; upload: [files: File[]] }>();

const done = computed(() => props.steps.filter((step) => step.done).length);
const cards = computed(() => props.steps.filter((step) => !step.done || (step.key === "documents" && props.uploading > 0)));
// Set once: a card that leaves does not widen the others.
const columns = cards.value.length < 3 ? "sm:grid-cols-2" : "sm:grid-cols-3";

const picker = ref<HTMLInputElement>();
const drop = useFileDrop(
	() => cards.value.some((step) => step.key === "documents"),
	(files) => emit("upload", files),
);

/** The card whose button was used last: its dialog or file picker gives focus back to that button. */
let actedOn = "";
function act(step: SetupStep) {
	actedOn = step.key;
	if (step.key === "instructions") emit("instructions");
	else if (step.key === "documents") picker.value?.click();
	else emit("share");
}

function picked(event: Event) {
	const files = pickedFiles(event);
	if (files.length) emit("upload", files);
}

/** A leaving card goes absolute; its box is pinned first, or it shrinks to its content and jumps to the corner. */
function pinBeforeLeave(element: Element) {
	if (!(element instanceof HTMLElement)) return;
	// Its button has focus, or will have it back from the dialog it opened, which may close first.
	focusLeaves ||= element.contains(document.activeElement) || element.dataset.step === actedOn;
	Object.assign(element.style, { width: `${element.offsetWidth}px`, height: `${element.offsetHeight}px`, left: `${element.offsetLeft}px`, top: `${element.offsetTop}px` });
}

/**
 * A card leaves when its dialog saves, or its files are up, and takes its button with it.
 * Focus that would fall to the page (the dialog gives it back to the gone button as it
 * closes) goes to the next card's button instead. Focus elsewhere, such as the message box, stays.
 */
const REFOCUS_MS = 800;
const list = ref<HTMLElement>();
let focusLeaves = false;
let refocusFrame = 0;
function refocusAfterLeave() {
	cancelAnimationFrame(refocusFrame);
	if (!focusLeaves) return;
	focusLeaves = false;
	const until = performance.now() + REFOCUS_MS;
	const check = () => {
		const lost = document.activeElement === document.body || document.activeElement === null;
		const next = list.value?.querySelector<HTMLElement>('[data-slot="workspace-setup-step"] button');
		if (lost && next) return next.focus();
		if (performance.now() < until) refocusFrame = requestAnimationFrame(check);
	};
	check();
}
onBeforeUnmount(() => cancelAnimationFrame(refocusFrame));
</script>

<template>
	<section class="space-y-3" aria-labelledby="workspace-setup-heading" data-slot="workspace-setup" v-on="drop.listeners">
		<div class="flex h-7 items-center justify-between gap-3">
			<h2 id="workspace-setup-heading" class="min-w-0 truncate text-base-semibold text-ink-gray-9">Set up {{ name }}</h2>
			<div class="flex shrink-0 items-center gap-2">
				<div class="h-1.5 w-16 overflow-hidden rounded-full bg-surface-gray-3" aria-hidden="true">
					<div
						class="h-full origin-left rounded-full bg-surface-gray-7 transition-transform duration-300 ease-out-strong motion-reduce:transition-none"
						:style="{ transform: `scaleX(${steps.length ? done / steps.length : 0})` }"
					/>
				</div>
				<p class="text-sm tabular-nums text-ink-gray-6" data-slot="workspace-setup-count">{{ count(done) }} of {{ count(steps.length) }} done</p>
			</div>
		</div>

		<!-- On a phone, a row that scrolls sideways, out to the screen's edges; a grid from sm. -->
		<div ref="list" class="scroll-fade-x -mx-4 overflow-x-auto [--scroll-fade-range:16px] [--scroll-fade-size:16px] sm:mx-0 sm:overflow-visible sm:[mask-image:none]">
			<TransitionGroup
				tag="div"
				class="relative flex snap-x snap-mandatory gap-4 px-4 py-1 [scroll-padding-inline:1rem] sm:grid sm:px-0"
				:class="columns"
				move-class="transition-transform duration-300 ease-out-strong motion-reduce:transition-none"
				enter-active-class="transition-[opacity,transform] duration-200 ease-out-strong motion-reduce:transition-none"
				enter-from-class="scale-[0.97] opacity-0 motion-reduce:scale-100"
				leave-active-class="absolute transition-[opacity,transform] duration-150 ease-out-strong motion-reduce:transition-none"
				leave-to-class="scale-[0.97] opacity-0 motion-reduce:scale-100"
				@before-leave="pinBeforeLeave"
				@after-leave="refocusAfterLeave"
			>
				<WorkspaceSetupCard
					v-for="step in cards"
					:key="step.key"
					class="w-64 shrink-0 snap-start sm:w-auto"
					:step="step"
					:busy="step.key === 'documents' && uploading > 0"
					:dropping="step.key === 'documents' && drop.active.value"
					@act="act(step)"
				/>
			</TransitionGroup>
		</div>
		<input ref="picker" type="file" class="hidden" multiple :accept="DOCUMENT_TYPES" aria-label="Upload documents" data-slot="document-picker" @change="picked" />
	</section>
</template>
