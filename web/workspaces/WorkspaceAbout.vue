<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { WorkspaceDocument } from "./documents";
import { useFileDrop } from "./file-drop";
import type { DocumentsHandle, UploadHandle } from "./handles";
import { canEdit, isShared, type WorkspaceDetail } from "./store";
import WorkspaceDocuments from "./WorkspaceDocuments.vue";
import WorkspaceInstructions from "./WorkspaceInstructions.vue";
import WorkspacePeople from "./WorkspacePeople.vue";

/**
 * What the workspace is, in the page's column (WorkspacePage.vue): the instructions that every
 * chat here follows, across the column, then its documents and its people (once it has more
 * than its owner) side by side from Tailwind's sm. Under the person's chats, or, while they
 * have none, it is the page, under the setup cards for editors. For people who can edit, an
 * empty section is one area that fills it, and files dropped anywhere here are uploaded, with
 * "Drop to upload" over the documents while they are dragged over it. While the setup cards
 * show (`setup`), they fill the empty sections, so only the sections that have something in
 * them show, as for people who can only ask.
 *
 * A section that shows once the page is open (a setup card added it) fades and rises 4px into
 * place; the sections the page opens with are just there.
 */
const props = defineProps<{ workspace: WorkspaceDetail; setup: boolean }>();
const emit = defineEmits<{ instructions: []; documents: [documents: WorkspaceDocument[]] }>();

const instructions = computed(() => props.workspace.instructions.trim());
const editable = computed(() => canEdit(props.workspace));
/** A private workspace with only its owner has no People to show until someone is added. */
const shared = computed(() => isShared(props.workspace));

/** Empty sections show for editors, as the area that fills them, unless the setup cards show. */
const showEmpty = computed(() => editable.value && !props.setup);
const showInstructions = computed(() => Boolean(instructions.value) || showEmpty.value);
const showDocuments = computed(() => props.workspace.documents.length > 0 || showEmpty.value);

/**
 * Each section's Transition plays on `appear` too, once the page is open: a section can come
 * with the section or row around it, which is new as well. With reduced motion, a fade only.
 */
const opened = ref(false);
onMounted(() => (opened.value = true));
const COME_IN = {
	enterFromClass: "translate-y-1 opacity-0 motion-reduce:translate-y-0",
	enterActiveClass: "transition-[opacity,transform] duration-200 ease-out-strong",
};

const documents = ref<DocumentsHandle>();
const drop = useFileDrop(
	() => editable.value && showDocuments.value,
	(files) => documents.value?.upload(files),
);
/** Files dropped on the page outside the sections (WorkspacePage.vue), once the person has chats here. */
defineExpose<UploadHandle>({ upload: async (files) => documents.value?.upload(files) });
</script>

<template>
	<section
		v-if="showInstructions || showDocuments || shared"
		class="flex flex-col gap-8"
		aria-label="About this workspace"
		data-slot="workspace-about"
		v-on="drop.listeners"
	>
		<Transition :appear="opened" v-bind="COME_IN">
			<WorkspaceInstructions v-if="showInstructions" :instructions="instructions" :editable="editable" @edit="emit('instructions')" />
		</Transition>

		<div v-if="showDocuments || shared" class="grid gap-8" :class="{ 'sm:grid-cols-2': showDocuments && shared }">
			<Transition :appear="opened" v-bind="COME_IN">
				<WorkspaceDocuments
					v-if="showDocuments"
					ref="documents"
					class="min-w-0"
					:workspace-id="workspace.id"
					:documents="workspace.documents"
					:editable="editable"
					:dropping="drop.active.value"
					@changed="emit('documents', $event)"
				/>
			</Transition>
			<Transition :appear="opened" v-bind="COME_IN">
				<WorkspacePeople v-if="shared" class="min-w-0" :detail="workspace" />
			</Transition>
		</div>
	</section>
</template>
