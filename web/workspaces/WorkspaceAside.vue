<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { computed, ref } from "vue";
import type { WorkspaceDocument } from "./documents";
import { useFileDrop } from "./file-drop";
import { canEdit, type WorkspaceDetail, type WorkspaceSummary } from "./store";
import WorkspaceDocuments from "./WorkspaceDocuments.vue";
import WorkspacePeople from "./WorkspacePeople.vue";

/**
 * The workspace page's side panel: the instructions that every chat here follows, its
 * documents, and its people. Beside the chats on a wide screen, under them on a phone. For
 * people who can edit, files dropped anywhere on the panel are uploaded, and empty sections
 * offer to fill them; for people who can only ask, empty sections are not shown. While the
 * workspace loads, the headings and their buttons stay, and skeleton lines stand in for the values.
 */
const props = defineProps<{ workspace?: WorkspaceSummary; detail?: WorkspaceDetail }>();
const emit = defineEmits<{ edit: []; documents: [documents: WorkspaceDocument[]] }>();

/** Long instructions show their first lines until asked for all. */
const LONG = 600;
const expanded = ref(false);
const instructions = computed(() => props.detail?.instructions.trim() ?? "");
const editable = computed(() => Boolean(props.workspace && canEdit(props.workspace)));

const documents = ref<InstanceType<typeof WorkspaceDocuments>>();
const drop = useFileDrop(
	() => editable.value && Boolean(props.detail),
	(files) => documents.value?.upload(files),
);
</script>

<template>
	<aside
		class="relative min-w-0 space-y-8 border-t border-outline-gray-1 pt-6 lg:border-t-0 lg:pt-0"
		aria-label="About this workspace"
		data-slot="workspace-aside"
		v-on="drop.listeners"
	>
		<section v-if="!detail || instructions || editable" class="space-y-3" aria-labelledby="workspace-instructions-heading">
			<h2 id="workspace-instructions-heading" class="flex h-7 items-center text-base-semibold text-ink-gray-9">Instructions</h2>
			<div v-if="!detail" class="space-y-1.5" aria-busy="true">
				<div v-for="width in ['w-full', 'w-11/12', 'w-2/3']" :key="width" class="flex h-[1lh] items-center text-p-sm"><Skeleton :class="['h-3 rounded-4', width]" /></div>
			</div>
			<template v-else-if="instructions">
				<p data-slot="workspace-instructions" class="whitespace-pre-wrap break-words text-p-sm text-ink-gray-8" :class="{ 'line-clamp-[12]': !expanded && instructions.length > LONG }">{{ instructions }}</p>
				<Button v-if="instructions.length > LONG" variant="ghost" size="sm" class="-ml-2" :label="expanded ? 'Show less' : 'Show all'" @click="expanded = !expanded" />
			</template>
			<Button v-else variant="ghost" label="Add instructions" class="-ml-2" data-slot="workspace-add-instructions" @click="emit('edit')" />
		</section>

		<WorkspaceDocuments
			v-if="!detail || detail.documents.length || editable"
			ref="documents"
			:workspace-id="detail?.id ?? workspace?.id ?? ''"
			:documents="detail?.documents"
			:editable="editable"
			@changed="emit('documents', $event)"
		/>

		<WorkspacePeople :detail="detail" />

		<div
			v-if="drop.active.value"
			class="pointer-events-none absolute inset-0 !mt-0 flex items-center justify-center rounded border border-dashed border-outline-gray-3 bg-surface-gray-1 text-base-medium text-ink-gray-8"
			data-slot="document-drop"
			aria-hidden="true"
		>
			<span class="flex items-center gap-2"><span class="lucide-upload size-4" aria-hidden="true" />Drop to upload</span>
		</div>
	</aside>
</template>
