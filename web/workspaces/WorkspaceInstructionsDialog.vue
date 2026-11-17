<script setup lang="ts">
import { Button, Dialog, ErrorMessage, FormControl } from "frappe-ui";
import { computed, nextTick, onMounted, ref } from "vue";
import { toast } from "../toasts";
import { dialogTitle, INSTRUCTIONS_PLACEHOLDER, workspaceDialog, type WorkspaceDialogRequest } from "./dialogs";
import { updateWorkspace } from "./store";

/**
 * A workspace's instructions, on their own: from "Add" by the empty Instructions, or "Edit"
 * by the filled ones. Saving changes only the instructions; empty ones clear them.
 */
const props = defineProps<{ request: Extract<WorkspaceDialogRequest, { kind: "instructions" }> }>();
const open = computed({ get: () => workspaceDialog.open, set: (value) => (workspaceDialog.open = value) });

const instructions = ref(props.request.workspace.instructions);
const error = ref("");
const saving = ref(false);

/**
 * frappe-ui's Dialog selects a field's text as it focuses it. Here the caret goes to the end
 * instead, so the first key press adds to the instructions rather than replacing them. This
 * runs after the Dialog's focus, which also waits a tick and a frame.
 */
onMounted(() =>
	nextTick(() =>
		requestAnimationFrame(() => {
			const field = document.activeElement;
			if (field instanceof HTMLTextAreaElement) field.setSelectionRange(field.value.length, field.value.length);
		}),
	),
);

async function save() {
	saving.value = true;
	error.value = "";
	try {
		props.request.onSaved(await updateWorkspace(props.request.workspace.id, { instructions: instructions.value.trim() }));
		toast.success("Instructions saved");
		open.value = false;
	} catch (failure) {
		error.value = (failure as Error).message;
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<Dialog v-model:open="open" :title="dialogTitle(request)" size="lg">
		<form class="space-y-4" @submit.prevent="save">
			<FormControl v-model="instructions" type="textarea" aria-label="Instructions" :placeholder="INSTRUCTIONS_PLACEHOLDER" :rows="10" autofocus />
			<ErrorMessage v-if="error" :message="error" />
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button type="submit" variant="solid" theme="gray" :loading="saving" label="Save" />
			</div>
		</form>
	</Dialog>
</template>
