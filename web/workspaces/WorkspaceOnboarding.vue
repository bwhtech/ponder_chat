<script setup lang="ts">
import { computed } from "vue";
import type { WorkspaceDocument } from "./documents";
import { setupSteps } from "./onboarding";
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
 */
const props = defineProps<{ workspace: WorkspaceDetail }>();
const emit = defineEmits<{ instructions: []; share: []; documents: [documents: WorkspaceDocument[]] }>();

const steps = computed(() => setupSteps(props.workspace));
const { uploading, errors, upload } = useDocumentUpload(
	() => props.workspace.id,
	() => props.workspace.documents,
	(documents) => emit("documents", documents),
);
const toDo = computed(() => steps.value.some((step) => !step.done) || uploading.value > 0);
</script>

<template>
	<div v-if="steps.length" class="space-y-3 empty:hidden">
		<Transition
			leave-to-class="opacity-0"
			leave-active-class="transition-opacity duration-150 ease-out-strong motion-reduce:transition-none"
		>
			<WorkspaceSetup v-if="toDo" :name="workspace.name" :steps="steps" :uploading="uploading" @instructions="emit('instructions')" @share="emit('share')" @upload="upload" />
		</Transition>
		<ul v-if="errors.length" class="space-y-1" role="alert" data-slot="document-upload-errors">
			<li v-for="error in errors" :key="error" class="break-words text-p-sm text-ink-red-6">{{ error }}</li>
		</ul>
	</div>
</template>
