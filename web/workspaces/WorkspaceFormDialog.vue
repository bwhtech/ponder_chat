<script setup lang="ts">
import { Button, Dialog, ErrorMessage, FormControl } from "frappe-ui";
import { computed, reactive, ref } from "vue";
import { toast } from "../toasts";
import { DESCRIPTION_PLACEHOLDER, dialogTitle, INSTRUCTIONS_PLACEHOLDER, KIND_OPTIONS, NAME_PLACEHOLDER, workspaceDialog, type WorkspaceDialogRequest } from "./dialogs";
import { createWorkspace, isAdmin, updateWorkspace } from "./store";

/**
 * New workspace, and Edit workspace: the name, what it is for, and the instructions every
 * chat in it follows. Only an admin chooses who can use a new one: anyone else makes a
 * private workspace, and shares it afterwards.
 */
const props = defineProps<{ request: Extract<WorkspaceDialogRequest, { kind: "new" | "edit" }> }>();
const open = computed({ get: () => workspaceDialog.open, set: (value) => (workspaceDialog.open = value) });
const editing = props.request.kind === "edit" ? props.request.workspace : null;
/** The field the dialog opens in (frappe-ui's Dialog focuses the `[autofocus]` one). */
const focusInstructions = props.request.kind === "edit" && props.request.focus === "instructions";

const form = reactive({
	name: editing?.name ?? "",
	description: editing?.description ?? "",
	instructions: editing?.instructions ?? "",
	kind: "private" as "org" | "private",
});
const nameError = ref("");
const error = ref("");
const saving = ref(false);

async function save() {
	nameError.value = form.name.trim() ? "" : "Give the workspace a name.";
	if (nameError.value) return;
	saving.value = true;
	error.value = "";
	const fields = { name: form.name.trim(), description: form.description.trim(), instructions: form.instructions.trim() };
	try {
		if (props.request.kind === "edit") {
			props.request.onSaved(await updateWorkspace(props.request.workspace.id, fields));
			toast.success("Workspace saved");
		} else {
			const made = await createWorkspace({ ...fields, kind: isAdmin.value ? form.kind : "private" });
			props.request.onMade(made.slug);
			toast.success(`Created “${made.name}”`);
		}
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
			<FormControl v-model="form.name" label="Name" :placeholder="NAME_PLACEHOLDER" :error="nameError" :autofocus="!focusInstructions" />
			<FormControl v-model="form.description" type="textarea" label="Description (optional)" :placeholder="DESCRIPTION_PLACEHOLDER" :rows="2" />
			<FormControl v-if="request.kind === 'new' && isAdmin" v-model="form.kind" type="select" label="Who can use it" :options="KIND_OPTIONS" />
			<FormControl v-model="form.instructions" type="textarea" label="Instructions (optional)" :placeholder="INSTRUCTIONS_PLACEHOLDER" :rows="6" :autofocus="focusInstructions" />
			<ErrorMessage v-if="error" :message="error" />
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button type="submit" variant="solid" theme="gray" :loading="saving" :label="request.kind === 'new' ? 'Create workspace' : 'Save'" />
			</div>
		</form>
	</Dialog>
</template>
