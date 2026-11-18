<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { count } from "../numbers";
import { workspaceDialog } from "./dialogs";
import { DOCUMENT_TYPES } from "./documents";
import { useFileDrop } from "./file-drop";
import type { SetupStep } from "./onboarding";
import { pickedFiles } from "./upload";
import WorkspaceSetupCard from "./WorkspaceSetupCard.vue";

/**
 * "Set up this workspace": a card for each step still to do, over the workspace's sections,
 * for a person who can edit it (WorkspaceOnboarding.vue). Each card's button opens what the
 * page opens elsewhere: the instructions dialog, the file picker, Share. A done step's card
 * leaves (the others slide into its place), and the bar fills. The Documents card stays while
 * its files go up. Files picked, or dropped on the cards, go to `upload`, which
 * WorkspaceOnboarding.vue does, with `uploading`.
 *
 * One column for each step this person has (two or three), so a workspace looks the same after
 * a reload as it did when a card left. When the column is too narrow for that (a phone, or a
 * sidebar and side panel beside it), the steps are rows instead, one under the other, all in
 * view above the message box.
 */
const props = defineProps<{ steps: SetupStep[]; uploading: number }>();
const emit = defineEmits<{ instructions: []; share: []; upload: [files: File[]] }>();

const done = computed(() => props.steps.filter((step) => step.done).length);
const cards = computed(() => props.steps.filter((step) => !step.done || (step.key === "documents" && props.uploading > 0)));

/**
 * Cards side by side need this much each, for their scenes; less, and the steps are rows. The
 * steps draw once the width is known (before the first paint), so they do not slide from rows
 * into cards as the page opens.
 */
const CARD_MIN_PX = 200;
const GAP_PX = 16;
const section = ref<HTMLElement>();
const width = ref(0);
const observer = new ResizeObserver(([entry]) => (width.value = entry?.contentRect.width ?? 0));
onMounted(() => {
	if (!section.value) return;
	width.value = section.value.clientWidth;
	observer.observe(section.value);
});
onBeforeUnmount(() => observer.disconnect());
const rows = computed(() => width.value < props.steps.length * CARD_MIN_PX + (props.steps.length - 1) * GAP_PX);

const picker = ref<HTMLInputElement>();
const drop = useFileDrop(
	() => cards.value.some((step) => step.key === "documents"),
	(files) => emit("upload", files),
);

/**
 * The card whose button was used last: its dialog or file picker gives focus back to that
 * button, which may be gone by then. Forgotten when the dialog or picker closes with the step
 * still to do (cancelled, or every file refused).
 */
let actedOn = "";
function act(step: SetupStep) {
	actedOn = step.key;
	if (step.key === "instructions") emit("instructions");
	else if (step.key === "documents") picker.value?.click();
	else emit("share");
}
const stillToDo = (key: string) => props.steps.some((step) => step.key === key && !step.done);
watch(
	() => workspaceDialog.open,
	(open) => !open && actedOn !== "documents" && stillToDo(actedOn) && (actedOn = ""),
	{ flush: "post" },
);
watch(
	() => props.uploading,
	(now) => now === 0 && actedOn === "documents" && stillToDo(actedOn) && (actedOn = ""),
	{ flush: "post" },
);

function picked(event: Event) {
	const files = pickedFiles(event);
	if (files.length) emit("upload", files);
	else if (actedOn === "documents") actedOn = "";
}

/**
 * Whether focus is on the setup, or will come back to it from a dialog or the file picker:
 * WorkspaceOnboarding.vue asks as the last card leaves, to move focus on to the message box.
 */
function holdsFocus() {
	return Boolean(section.value?.contains(document.activeElement)) || actedOn !== "";
}
defineExpose({ holdsFocus });

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
let focusLeaves = false;
let refocusFrame = 0;
function refocusAfterLeave() {
	cancelAnimationFrame(refocusFrame);
	if (!focusLeaves) return;
	focusLeaves = false;
	actedOn = "";
	const until = performance.now() + REFOCUS_MS;
	const check = () => {
		const lost = document.activeElement === document.body || document.activeElement === null;
		const next = section.value?.querySelector<HTMLElement>('[data-slot="workspace-setup-step"] button');
		if (lost && next) return next.focus();
		if (performance.now() < until) refocusFrame = requestAnimationFrame(check);
	};
	check();
}
onBeforeUnmount(() => cancelAnimationFrame(refocusFrame));
</script>

<template>
	<section ref="section" aria-labelledby="workspace-setup-heading" data-slot="workspace-setup" v-on="drop.listeners">
		<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
			<h2 id="workspace-setup-heading" class="text-lg-semibold text-ink-gray-9">Set up this workspace</h2>
			<div class="flex shrink-0 items-center gap-2">
				<div class="h-1.5 w-20 overflow-hidden rounded-full bg-surface-gray-2" aria-hidden="true">
					<div
						class="h-full origin-left rounded-full bg-surface-gray-7 transition-transform duration-300 ease-out-strong motion-reduce:transition-none"
						:style="{ transform: `scaleX(${steps.length ? done / steps.length : 0})` }"
					/>
				</div>
				<p class="text-sm tabular-nums text-ink-gray-6" data-slot="workspace-setup-count">{{ count(done) }} of {{ count(steps.length) }} done</p>
			</div>
		</div>
		<p class="mt-1 text-p-sm text-ink-gray-6">You can ask questions now and set these up any time.</p>

		<TransitionGroup
			v-if="width"
			tag="div"
			class="relative mt-4"
			:class="rows ? 'flex flex-col gap-3' : ['grid gap-4', steps.length < 3 ? 'grid-cols-2' : 'grid-cols-3']"
			move-class="transition-transform duration-300 ease-out-strong motion-reduce:transition-none"
			enter-active-class="transition-[opacity,transform] duration-200 ease-out-strong motion-reduce:transition-opacity"
			enter-from-class="scale-[0.97] opacity-0 motion-reduce:scale-100"
			leave-active-class="absolute transition-[opacity,transform] duration-150 ease-out-strong motion-reduce:transition-opacity"
			leave-to-class="scale-[0.97] opacity-0 motion-reduce:scale-100"
			@before-leave="pinBeforeLeave"
			@after-leave="refocusAfterLeave"
		>
			<WorkspaceSetupCard
				v-for="step in cards"
				:key="step.key"
				:step="step"
				:compact="rows"
				:busy="step.key === 'documents' && uploading > 0"
				:dropping="step.key === 'documents' && drop.active.value"
				@act="act(step)"
			/>
		</TransitionGroup>
		<input ref="picker" type="file" class="hidden" multiple :accept="DOCUMENT_TYPES" aria-label="Upload documents" data-slot="document-picker" @change="picked" @cancel="picked" />
	</section>
</template>
