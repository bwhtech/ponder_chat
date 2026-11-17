<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { ref } from "vue";
import { dialog } from "../dialogs";
import { toast } from "../toasts";
import DocumentRow from "./DocumentRow.vue";
import { deleteDocument, DOCUMENT_TYPES, retryDocument, uploadDocument, type WorkspaceDocument } from "./documents";
import { openWorkspaceDialog } from "./dialogs";

/**
 * The workspace's documents, in its side panel. Everyone who can ask sees each document's
 * name, and its status while it is not Ready. People who can edit also see its size and why
 * it failed, upload (the button, or files dropped on the panel: WorkspaceAside.vue calls
 * `upload`), delete, open its Details (the indexing log) and "Try again" a document that
 * failed. The file picker
 * offers only the types the server reads; a file it refuses gets the server's reason. The
 * page polls while one is Reading (WorkspacePage.vue); `changed` hands it the new list
 * after each change here.
 */
const props = defineProps<{ workspaceId: string; documents?: WorkspaceDocument[]; editable: boolean }>();
const emit = defineEmits<{ changed: [documents: WorkspaceDocument[]] }>();

const picker = ref<HTMLInputElement>();
const uploading = ref(0);
const errors = ref<string[]>([]);
const retrying = ref(new Set<string>());

defineExpose({ upload });

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
		message: `“${document.name}” will be deleted.`,
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
	<section class="space-y-3" aria-labelledby="workspace-documents-heading" data-slot="workspace-documents">
		<div class="flex h-7 items-center justify-between">
			<h2 id="workspace-documents-heading" class="text-base-semibold text-ink-gray-9">Documents</h2>
			<template v-if="editable">
				<Button variant="ghost" icon-left="lucide-upload" label="Upload" class="touch-target -mr-2" :loading="uploading > 0" :disabled="!documents" @click="picker?.click()" />
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

		<ul v-if="errors.length" class="space-y-1" role="alert" data-slot="document-upload-errors">
			<li v-for="error in errors" :key="error" class="break-words text-p-sm text-ink-red-6">{{ error }}</li>
		</ul>
	</section>
</template>
