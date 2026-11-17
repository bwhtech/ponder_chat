<script setup lang="ts">
import { computed, ref } from "vue";
import type { WorkspaceDocument } from "./documents";
import { useFileDrop } from "./file-drop";
import { canEdit, type WorkspaceDetail, type WorkspaceSummary } from "./store";
import WorkspaceDocuments from "./WorkspaceDocuments.vue";
import WorkspaceInstructions from "./WorkspaceInstructions.vue";
import WorkspacePeople from "./WorkspacePeople.vue";

/**
 * The workspace page's side panel: the instructions that every chat here follows, its
 * documents, and its people (once it has more than its owner). Beside the chats on a wide
 * screen, under them on a phone. For people who can edit, an empty section is one area that
 * fills it, and files dropped anywhere on the panel are uploaded, with "Drop to upload" over
 * the documents while they are dragged over it. For people who can only ask, empty sections
 * are not shown, so their panel waits for the workspace: which sections it has is not known
 * before. For editors, while the workspace loads, the headings stay, and skeleton lines stand
 * in for the values.
 */
const props = defineProps<{ workspace?: WorkspaceSummary; detail?: WorkspaceDetail }>();
const emit = defineEmits<{ instructions: []; documents: [documents: WorkspaceDocument[]] }>();

const instructions = computed(() => props.detail?.instructions.trim());
const editable = computed(() => Boolean(props.workspace && canEdit(props.workspace)));
/** A private workspace with only its owner has no People to show until someone is added. */
const shared = computed(() => {
	const workspace = props.detail ?? props.workspace;
	return !workspace || workspace.kind === "org" || workspace.memberCount > 0;
});

const documents = ref<InstanceType<typeof WorkspaceDocuments>>();
const drop = useFileDrop(
	() => editable.value && Boolean(props.detail),
	(files) => documents.value?.upload(files),
);
</script>

<template>
	<aside v-if="detail || editable" class="min-w-0 space-y-8" aria-label="About this workspace" data-slot="workspace-aside" v-on="drop.listeners">
		<WorkspaceInstructions v-if="!detail || instructions || editable" :instructions="instructions" :editable="editable" @edit="emit('instructions')" />

		<WorkspaceDocuments
			v-if="!detail || detail.documents.length || editable"
			ref="documents"
			:workspace-id="detail?.id ?? workspace?.id ?? ''"
			:documents="detail?.documents"
			:editable="editable"
			:dropping="drop.active.value"
			@changed="emit('documents', $event)"
		/>

		<WorkspacePeople v-if="shared" :detail="detail" />
	</aside>
</template>
