import { ref } from "vue";
import { uploadDocument, type WorkspaceDocument } from "./documents";

/**
 * Uploads documents to a workspace, one at a time and in order: each answer adds its row at
 * once (`changed` gets the new list). A file the server refuses adds its reason to `errors`.
 * The side panel's Documents section has one of these, and the setup steps another
 * (WorkspaceOnboarding.vue); each takes files from its own file picker (`pickedFiles`) or a drop.
 */
export function useDocumentUpload(workspaceId: () => string, documents: () => readonly WorkspaceDocument[], changed: (documents: WorkspaceDocument[]) => void) {
	const uploading = ref(0);
	const errors = ref<string[]>([]);

	async function upload(files: File[]) {
		if (!files.length) return;
		errors.value = [];
		uploading.value += files.length;
		for (const file of files) {
			try {
				const document = await uploadDocument(workspaceId(), file);
				changed([...documents(), document]);
			} catch (error) {
				errors.value = [...errors.value, (error as Error).message];
			} finally {
				uploading.value--;
			}
		}
	}

	return { uploading, errors, upload };
}

/** A file picker's files, with the picker emptied, so the same file can be picked again. */
export function pickedFiles(event: Event) {
	const input = event.target as HTMLInputElement;
	const files = Array.from(input.files ?? []);
	input.value = "";
	return files;
}
