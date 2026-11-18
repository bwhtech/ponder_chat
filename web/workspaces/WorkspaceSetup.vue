<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
 * leaves (the others slide into its place), and its segment of the progress fills. The
 * Sources card stays while its files go up. Files picked, or dropped on the cards, go to
 * `upload` (WorkspaceOnboarding.vue), which settles once they are all up or refused.
 *
 * One column for each step this person has (two or three), so a workspace looks the same after
 * a reload as it did when a card left. The steps are rows instead, one under the other, when
 * the column is too narrow for that (a phone, or a sidebar and side panel beside it), and when
 * one step is left: a lone card would leave a hole beside it.
 */
/**
 * `dragging`: files are dragged somewhere over the page, and a drop there uploads them
 * (WorkspacePage.vue): the Sources step says it takes them. `askNext`: focus fell to the page
 * and no step's button can take it (the one left is busy uploading): the message box should.
 */
const props = defineProps<{ steps: SetupStep[]; uploading: number; upload: (files: File[]) => Promise<void>; dragging?: boolean }>();
const emit = defineEmits<{ instructions: []; share: []; askNext: [] }>();

const done = computed(() => props.steps.filter((step) => step.done).length);
const filled = (index: number) => index < done.value;
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
const widthObserver = new ResizeObserver(([entry]) => (width.value = entry?.contentRect.width ?? 0));
onMounted(() => {
	if (!section.value) return;
	width.value = section.value.clientWidth;
	widthObserver.observe(section.value);
});
onBeforeUnmount(() => widthObserver.disconnect());
const narrow = computed(() => width.value < props.steps.length * CARD_MIN_PX + (props.steps.length - 1) * GAP_PX);
const rows = computed(() => cards.value.length === 1 || narrow.value);

/**
 * The steps' height follows them over 300ms: when the second-last card leaves and the last
 * one becomes a row, the sections under them rise rather than jump. A card or row that
 * changes layout cross-fades (it has a new key). If its button had focus, the new one takes it.
 */
const list = ref<HTMLElement>();
const listHeight = ref(0);
/** While the height moves, what is outside it is clipped: steps that grow do not spill over the sections below. */
const clipping = ref(false);
const HEIGHT_MS = 300;
let clipTimer = 0;
const heightObserver = new ResizeObserver(([entry]) => {
	const height = entry ? Math.ceil(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height) : 0;
	if (listHeight.value && height !== listHeight.value) {
		clipping.value = true;
		clearTimeout(clipTimer);
		clipTimer = window.setTimeout(() => (clipping.value = false), HEIGHT_MS);
	}
	listHeight.value = height;
});
watch(list, (now, before) => {
	if (before) heightObserver.unobserve(before);
	if (now) heightObserver.observe(now);
});
onBeforeUnmount(() => {
	heightObserver.disconnect();
	clearTimeout(clipTimer);
});
watch(
	rows,
	async () => {
		const focused = document.activeElement?.closest<HTMLElement>('[data-slot="workspace-setup-step"]');
		const key = focused && section.value?.contains(focused) ? focused.dataset.step : undefined;
		if (!key) return;
		await nextTick();
		section.value?.querySelector<HTMLElement>(`[data-step="${key}"][data-layout="${rows.value ? "row" : "card"}"] button`)?.focus();
	},
	{ flush: "pre" },
);

const drop = useFileDrop(
	() => cards.value.some((step) => step.key === "documents"),
	(files) => void props.upload(files),
);
const documentsDropping = computed(() => drop.active.value || Boolean(props.dragging && cards.value.some((step) => step.key === "documents")));

/**
 * The card whose button was used last: its dialog or file picker gives focus back to that
 * button, which may be gone by then. Forgotten when the dialog or picker closes with the step
 * still to do: cancelled, or every file refused.
 */
let actedOn = "";
const picker = ref<HTMLInputElement>();
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

async function picked(event: Event) {
	const files = pickedFiles(event);
	if (files.length) await props.upload(files);
	// Settled: up, refused, or none picked. The page has the new documents by the next render.
	await nextTick();
	if (actedOn === "documents" && stillToDo("documents")) actedOn = "";
}

/**
 * Whether focus is on the setup, or will come back to it from a dialog or the file picker:
 * WorkspaceOnboarding.vue asks as the last card leaves, to move focus on to the message box.
 */
function holdsFocus() {
	return Boolean(section.value?.contains(document.activeElement)) || actedOn !== "";
}
defineExpose({ holdsFocus });

/**
 * A leaving card goes absolute (`!absolute`: Tailwind writes the card's own `relative` after
 * it); its box is pinned first, or it shrinks to its content and jumps to the corner. It is inert at once: no click or focus lands on it, and a screen reader no
 * longer finds it beside the card that takes its place.
 */
function pinBeforeLeave(element: Element) {
	if (!(element instanceof HTMLElement)) return;
	// Its button has focus, or will have it back from the dialog it opened, which may close first.
	focusLeaves ||= element.contains(document.activeElement) || element.dataset.step === actedOn;
	Object.assign(element.style, { width: `${element.offsetWidth}px`, height: `${element.offsetHeight}px`, left: `${element.offsetLeft}px`, top: `${element.offsetTop}px` });
	element.inert = true;
	element.setAttribute("aria-hidden", "true");
}

/**
 * A card leaves when its dialog saves, or its files are up, and takes its button with it.
 * Focus that would fall to the page (the dialog gives it back to the gone button as it
 * closes) goes to the next card's button that takes it, not one disabled while its files go
 * up; with none, to the message box. Focus elsewhere, such as the message box, stays.
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
		if (lost) {
			const next = section.value?.querySelector<HTMLElement>('[data-slot="workspace-setup-step"]:not([inert]) button:not(:disabled)');
			next?.focus();
			if (!next || document.activeElement !== next) return emit("askNext");
			return;
		}
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
				<!-- A segment for each step; as many as are done fill, from the left, whichever steps they were. -->
				<div class="flex gap-1" aria-hidden="true" data-slot="workspace-setup-progress">
					<span
						v-for="(step, index) in steps"
						:key="step.key"
						class="h-1.5 w-5 rounded-full transition-colors duration-300 ease-out-strong motion-reduce:transition-none"
						:class="filled(index) ? 'bg-surface-gray-7' : 'bg-surface-gray-3'"
						:data-filled="filled(index) || undefined"
					/>
				</div>
				<p class="text-sm tabular-nums text-ink-gray-6" data-slot="workspace-setup-count">{{ count(done) }} of {{ count(steps.length) }} done</p>
			</div>
		</div>
		<p class="mt-1 text-p-sm text-ink-gray-6">You can ask questions now and set these up any time.</p>

		<div
			class="mt-4 transition-[height] duration-300 ease-out-strong motion-reduce:transition-none"
			:class="{ 'overflow-hidden': clipping }"
			:style="listHeight ? { height: `${listHeight}px` } : undefined"
		>
			<div ref="list">
				<TransitionGroup
					v-if="width"
					tag="div"
					class="relative"
					:class="rows ? 'flex flex-col gap-3' : ['grid gap-4', steps.length < 3 ? 'grid-cols-2' : 'grid-cols-3']"
					move-class="transition-transform duration-300 ease-out-strong motion-reduce:transition-none"
					enter-active-class="transition-[opacity,transform] duration-200 ease-out-strong motion-reduce:transition-opacity"
					enter-from-class="scale-[0.97] opacity-0 motion-reduce:scale-100"
					leave-active-class="!absolute transition-[opacity,transform] duration-150 ease-out-strong motion-reduce:transition-opacity"
					leave-to-class="scale-[0.97] opacity-0 motion-reduce:scale-100"
					@before-leave="pinBeforeLeave"
					@after-leave="refocusAfterLeave"
				>
					<WorkspaceSetupCard
						v-for="step in cards"
						:key="`${step.key}:${rows ? 'row' : 'card'}`"
						:step="step"
						:compact="rows"
						:busy="step.key === 'documents' && uploading > 0"
						:dropping="step.key === 'documents' && documentsDropping"
						@act="act(step)"
					/>
				</TransitionGroup>
			</div>
		</div>
		<input ref="picker" type="file" class="hidden" multiple :accept="DOCUMENT_TYPES" aria-label="Upload files" data-slot="document-picker" @change="picked" @cancel="picked" />
	</section>
</template>
