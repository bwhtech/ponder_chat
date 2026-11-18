<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { WorkspaceDocument } from "./documents";
import { setupSteps, starterQuestions } from "./onboarding";
import type { WorkspaceDetail } from "./store";
import { useDocumentUpload } from "./upload";
import WorkspaceSetup from "./WorkspaceSetup.vue";
import WorkspaceStarters from "./WorkspaceStarters.vue";

/**
 * What a workspace page shows where the person's chats go, while they have none in it
 * (WorkspacePage.vue). A person who can edit sees the setup steps until each one is done;
 * then, and from the start for a person who can only ask, first questions to start with.
 * Once the last step ticks, the steps stay a moment, so the tick is seen, and until all the
 * files picked there are up, before the questions take their place. The uploads live here,
 * not in the steps, so each file that arrives reaches the page.
 */
const props = defineProps<{ workspace: WorkspaceDetail }>();
const emit = defineEmits<{ instructions: []; share: []; documents: [documents: WorkspaceDocument[]]; pick: [question: string] }>();

const TICK_SEEN_MS = 700;
const steps = computed(() => setupSteps(props.workspace));
const { uploading, errors, upload } = useDocumentUpload(
	() => props.workspace.id,
	() => props.workspace.documents,
	(documents) => emit("documents", documents),
);
const setupDone = computed(() => steps.value.every((step) => step.done) && !uploading.value);
const showSetup = ref(!setupDone.value);
let timer: ReturnType<typeof setTimeout> | undefined;
watch(setupDone, (done) => {
	clearTimeout(timer);
	if (!done) showSetup.value = true;
	else timer = setTimeout(() => (showSetup.value = false), TICK_SEEN_MS);
});
onBeforeUnmount(() => clearTimeout(timer));

const questions = computed(() => starterQuestions(props.workspace.name, props.workspace.documents));
</script>

<template>
	<Transition
		mode="out-in"
		enter-from-class="opacity-0"
		leave-to-class="opacity-0"
		enter-active-class="transition-opacity duration-200 ease-out-strong motion-reduce:transition-none"
		leave-active-class="transition-opacity duration-150 ease-out-strong motion-reduce:transition-none"
	>
		<WorkspaceSetup
			v-if="showSetup"
			:workspace="workspace"
			:steps="steps"
			:uploading="uploading"
			:errors="errors"
			@instructions="emit('instructions')"
			@share="emit('share')"
			@upload="upload"
		/>
		<WorkspaceStarters v-else :name="workspace.name" :questions="questions" @pick="emit('pick', $event)" />
	</Transition>
</template>
