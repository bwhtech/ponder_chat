<script setup lang="ts">
import { Button, Dialog, ErrorMessage, FormControl } from "frappe-ui";
import { computed, reactive, ref } from "vue";
import { toast } from "../toasts";
import { dialogTitle, KIND_OPTIONS, workspaceDialog, type WorkspaceDialogRequest } from "./dialogs";
import { createWorkspace, isAdmin, showWorkspace, updateWorkspace } from "./store";

/**
 * New workspace, and Edit workspace: the name, what it is for, and the instructions every
 * chat in it follows. Only an admin chooses who can use a new one: anyone else makes a
 * private workspace, and shares it afterwards.
 */
const props = defineProps<{ request: Exclude<WorkspaceDialogRequest, { kind: "share" }> }>();
const open = computed({ get: () => workspaceDialog.open, set: (value) => (workspaceDialog.open = value) });
const editing = props.request.kind === "edit" ? props.request.workspace : null;

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
			showWorkspace(made.id);
			toast.success(`Made “${made.name}”`);
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
			<FormControl v-model="form.name" label="Name" placeholder="HR policies" required :error="nameError" />
			<FormControl v-model="form.description" label="What is it for?" description="Shown on the workspace page." />
			<FormControl v-if="request.kind === 'new' && isAdmin" v-model="form.kind" type="select" label="Who can use it" :options="KIND_OPTIONS" />
			<FormControl
				v-model="form.instructions"
				type="textarea"
				label="Instructions"
				description="Every chat in this workspace follows these."
				placeholder="Answer from our policies. Name the policy you used."
				:rows="6"
			/>
			<ErrorMessage v-if="error" :message="error" />
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button type="submit" variant="solid" theme="gray" :loading="saving" :label="request.kind === 'new' ? 'Create workspace' : 'Save'" />
			</div>
		</form>
	</Dialog>
</template>
