<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { computed, ref } from "vue";
import { dialog } from "../dialogs";
import { toast } from "../toasts";
import DocumentRow from "./DocumentRow.vue";
import { deleteDocument, DOCUMENT_TYPES, retryDocument, uploadDocument, type WorkspaceDocument } from "./documents";
import { openWorkspaceDialog } from "./dialogs";

/**
 * The workspace's documents, in its side panel. Everyone who can ask sees each document's
 * name and status. People who can edit also see its size and why it failed, upload (the
 * button, or a file dropped on the section), delete, open its Details (the indexing log)
 * and "Try again" a document that failed. The page polls while one is Reading
 * (WorkspacePage.vue); `changed` hands it the new list after each change here.
 */
const props = defineProps<{ workspaceId: string; documents?: WorkspaceDocument[]; editable: boolean }>();
const emit = defineEmits<{ changed: [documents: WorkspaceDocument[]] }>();

const picker = ref<HTMLInputElement>();
const uploading = ref(0);
const errors = ref<string[]>([]);
const retrying = ref(new Set<string>());
// dragenter and dragleave fire for each child: a count tells when the file left the section.
const dragDepth = ref(0);
const dropping = computed(() => props.editable && dragDepth.value > 0);

function current() {
	return props.documents ?? [];
}

async function upload(files: File[]) {
	if (!files.length) return;
	errors.value = [];
	uploading.value += files.length;
	// One at a time, in order: each answer adds its row at once.
	for (const file of files) {
		try {
			const document = await uploadDocument(props.workspaceId, file);
			emit("changed", [...current(), document]);
		} catch (error) {
			errors.value = [...errors.value, (error as Error).message];
		} finally {
			uploading.value--;
		}
	}
}

function picked(event: Event) {
	const input = event.target as HTMLInputElement;
	void upload(Array.from(input.files ?? []));
	input.value = "";
}

function hasFiles(event: DragEvent) {
	return props.editable && Boolean(event.dataTransfer?.types.includes("Files"));
}

function dragEnter(event: DragEvent) {
	if (!hasFiles(event)) return;
	event.preventDefault();
	dragDepth.value++;
}

function dragOver(event: DragEvent) {
	if (!hasFiles(event)) return;
	event.preventDefault();
	event.dataTransfer!.dropEffect = "copy";
}

function drop(event: DragEvent) {
	if (!hasFiles(event)) return;
	event.preventDefault();
	dragDepth.value = 0;
	void upload(Array.from(event.dataTransfer?.files ?? []));
}

function details(document: WorkspaceDocument) {
	openWorkspaceDialog({ kind: "document", workspaceId: props.workspaceId, document, onChanged: replace });
}

function replace(document: WorkspaceDocument) {
	emit(
		"changed",
		current().map((other) => (other.id === document.id ? document : other)),
	);
}

async function retry(document: WorkspaceDocument) {
	retrying.value = new Set([...retrying.value, document.id]);
	try {
		replace(await retryDocument(props.workspaceId, document.id));
	} catch (error) {
		toast.error((error as Error).message);
	} finally {
		retrying.value = new Set([...retrying.value].filter((id) => id !== document.id));
	}
}

function askDelete(document: WorkspaceDocument) {
	dialog.danger({
		title: "Delete this document?",
		message: `“${document.name}” will be deleted. Chats here will no longer use it.`,
		onConfirm: async () => {
			await deleteDocument(props.workspaceId, document.id);
			emit(
				"changed",
				current().filter((other) => other.id !== document.id),
			);
			toast.success(`Deleted “${document.name}”`);
		},
	});
}
</script>

<template>
	<section
		class="relative space-y-3"
		aria-labelledby="workspace-documents-heading"
		data-slot="workspace-documents"
		@dragenter="dragEnter"
		@dragover="dragOver"
		@dragleave="dragDepth = Math.max(0, dragDepth - 1)"
		@drop="drop"
	>
		<div class="flex h-7 items-center justify-between">
			<h2 id="workspace-documents-heading" class="text-base-semibold text-ink-gray-9">Documents</h2>
			<template v-if="editable">
				<Button variant="ghost" icon-left="lucide-upload" label="Upload" class="-mr-2" :loading="uploading > 0" :disabled="!documents" @click="picker?.click()" />
				<input ref="picker" type="file" class="hidden" multiple :accept="DOCUMENT_TYPES" aria-label="Upload documents" data-slot="document-picker" @change="picked" />
			</template>
		</div>

		<ul v-if="!documents" class="space-y-1" aria-busy="true" aria-label="Loading documents">
			<li v-for="width in ['w-40', 'w-32']" :key="width" class="flex gap-2.5 py-1">
				<Skeleton class="mt-0.5 size-4 shrink-0 rounded-4" />
				<div class="min-w-0 flex-1">
					<div class="flex h-[1lh] items-center text-sm"><Skeleton :class="['h-3 rounded-4', width]" /></div>
					<div class="flex h-[1lh] items-center text-p-sm"><Skeleton class="h-2.5 w-16 rounded-4" /></div>
				</div>
			</li>
		</ul>

		<ul v-else-if="documents.length" class="space-y-1" data-slot="document-list">
			<DocumentRow
				v-for="document in documents"
				:key="document.id"
				:document="document"
				:editable="editable"
				:retrying="retrying.has(document.id)"
				@details="details(document)"
				@retry="retry(document)"
				@delete="askDelete(document)"
			/>
		</ul>

		<button
			v-else-if="editable"
			type="button"
			class="flex w-full flex-col items-center gap-1.5 rounded-5 border border-dashed border-outline-gray-2 px-4 py-6 text-center transition-colors duration-150 ease-out-strong hover:bg-surface-gray-1 motion-reduce:transition-none"
			data-slot="document-drop"
			@click="picker?.click()"
		>
			<span class="lucide-file-up size-5 text-ink-gray-4" aria-hidden="true" />
			<span class="text-sm text-ink-gray-8">Drop files here, or choose them</span>
			<span class="text-p-sm text-ink-gray-6">PDF, text, Markdown, CSV, TSV or JSON, up to 10 MB each.</span>
		</button>
		<p v-else class="text-p-sm text-ink-gray-6">No documents yet.</p>

		<ul v-if="errors.length" class="space-y-1" role="alert" data-slot="document-upload-errors">
			<li v-for="error in errors" :key="error" class="text-p-sm text-ink-red-6">{{ error }}</li>
		</ul>
		<p v-if="editable && documents?.length" class="text-p-sm text-ink-gray-6">Chats here answer from these. Drop a file on this list to add it.</p>

		<div
			v-if="dropping"
			class="pointer-events-none absolute -inset-2 !mt-0 flex items-center justify-center rounded-5 border border-dashed border-outline-gray-4 bg-surface-base text-sm text-ink-gray-8"
			aria-hidden="true"
		>
			Drop to add to this workspace
		</div>
	</section>
</template>
