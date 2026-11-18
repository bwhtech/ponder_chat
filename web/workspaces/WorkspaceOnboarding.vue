<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { count } from "../numbers";
import type { WorkspaceDocument } from "./documents";
import type { SetupHandle, UploadHandle } from "./handles";
import { setupSteps, type SetupStepKey } from "./onboarding";
import type { WorkspaceDetail } from "./store";
import { useDocumentUpload } from "./upload";
import WorkspaceSetup from "./WorkspaceSetup.vue";

/**
 * The top of a workspace page while the person has no chat in it (WorkspacePage.vue): for a
 * person who can edit, a card for each setup step still to do. A person who can only ask has
 * none: the workspace's sections under it are the page. The cards go once each step is done,
 * and all the files picked on them are up. The uploads live here, not in the cards, so each
 * file that arrives reaches the page, and a file the server refused keeps its reason in view
 * after the last card left, until the next upload.
 *
 * A workspace with nothing set up sits a little lower on a wide screen. As the last card
 * goes, the setup fades and folds up, so the sections under it rise with it rather than jump.
 * The status line, for screen readers, stays after the cards: it says what each step added, and
 * when the workspace is set up.
 */
/** `dragging`: files are dragged over the page, and a drop anywhere on it comes here (WorkspacePage.vue). */
const props = defineProps<{ workspace: WorkspaceDetail; dragging?: boolean }>();
const emit = defineEmits<{ instructions: []; share: []; documents: [documents: WorkspaceDocument[]]; finished: [] }>();

const steps = computed(() => setupSteps(props.workspace));
const { uploading, errors, upload } = useDocumentUpload(
	() => props.workspace.id,
	() => props.workspace.documents,
	(documents) => emit("documents", documents),
);
const toDo = computed(() => steps.value.some((step) => !step.done) || uploading.value > 0);
const fresh = computed(() => steps.value.every((step) => !step.done));

const ADDED: Record<SetupStepKey, string> = { instructions: "Instructions added.", documents: "Sources added.", people: "Workspace shared." };
const doneKeys = computed(() => steps.value.filter((step) => step.done).map((step) => step.key));
const announcement = ref("");
watch([doneKeys, toDo, () => props.workspace.kind], ([now, wanted, kind], [before, wanted0, kind0]) => {
	const parts = now.filter((key) => !before.includes(key)).map((key) => ADDED[key]);
	// Shared with the whole organisation: its People step goes rather than turns done, and no toast says so.
	if (kind0 === "private" && kind === "org") parts.unshift("Workspace shared with everyone in the organisation.");
	if (wanted0 && !wanted) parts.push("Workspace set up.");
	else if (parts.length) parts.push(`${count(now.length)} of ${count(steps.value.length)} done.`);
	if (parts.length) announcement.value = parts.join(" ");
});

/**
 * The last card takes its button with it, and the whole setup goes. If focus was there, or
 * comes back there from the dialog or file picker that did the step, it falls to the page:
 * the message box takes it (`finished`), since asking is what is left to do. Focus elsewhere stays.
 */
const REFOCUS_MS = 800;
const setup = ref<SetupHandle>();
let focusLeaves = false;
let refocusFrame = 0;
// Before the setup unmounts, while it can still say where focus is.
watch(toDo, (now) => !now && (focusLeaves = setup.value?.holdsFocus() ?? false), { flush: "pre" });
function refocusAfterLeave() {
	cancelAnimationFrame(refocusFrame);
	if (!focusLeaves) return;
	focusLeaves = false;
	const until = performance.now() + REFOCUS_MS;
	const check = () => {
		if (document.activeElement === document.body || document.activeElement === null) return emit("finished");
		if (performance.now() < until) refocusFrame = requestAnimationFrame(check);
	};
	check();
}
onBeforeUnmount(() => cancelAnimationFrame(refocusFrame));

/** Files dropped on the page around the setup (WorkspacePage.vue) go up here too, so the Sources step counts them. */
defineExpose<UploadHandle>({ upload });
</script>

<template>
	<!-- The page puts 32px between this and the sections; the setup and the errors carry it at their
	     bottom instead (-mb-8), so it folds away with them. -->
	<div v-if="steps.length" class="-mb-8 transition-[padding] duration-300 ease-out-strong motion-reduce:transition-none" :class="{ 'sm:pt-6': fresh }">
		<p class="sr-only" role="status" data-slot="workspace-setup-status">{{ announcement }}</p>
		<Transition
			leave-active-class="grid transition-[grid-template-rows,opacity] duration-[300ms,150ms] ease-out-strong motion-reduce:transition-[opacity] motion-reduce:duration-150 motion-reduce:ease-out-strong [&>*]:min-h-0 [&>*]:overflow-hidden"
			leave-from-class="grid-rows-[1fr]"
			leave-to-class="grid-rows-[0fr] opacity-0 motion-reduce:grid-rows-[1fr]"
			@after-leave="refocusAfterLeave"
		>
			<!-- The padding is a level down from the folding row, which can then fold to nothing. -->
			<div v-if="toDo">
				<div>
					<WorkspaceSetup
						ref="setup"
						:class="errors.length ? 'pb-3' : 'pb-8'"
						:steps="steps"
						:uploading="uploading"
						:upload="upload"
						:dragging="dragging"
						@instructions="emit('instructions')"
						@share="emit('share')"
						@ask-next="emit('finished')"
					/>
				</div>
			</div>
		</Transition>
		<ul v-if="errors.length" class="space-y-1 pb-8" role="alert" data-slot="document-upload-errors">
			<li v-for="error in errors" :key="error" class="break-words text-p-sm text-ink-red-6">{{ error }}</li>
		</ul>
	</div>
</template>
