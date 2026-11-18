<script setup lang="ts">
import { Button, Dialog, ErrorMessage, FormControl } from "frappe-ui";
import { computed, reactive, ref } from "vue";
import { dialogTitle, INSTRUCTIONS_PLACEHOLDER, KIND_OPTIONS, NAME_PLACEHOLDER, workspaceDialog, type WorkspaceDialogRequest } from "./dialogs";
import { createWorkspace, isAdmin } from "./store";

/**
 * New workspace: its name and the instructions every chat in it follows. Only an admin
 * chooses who can use it: anyone else makes a private workspace, and shares it afterwards.
 */
const props = defineProps<{ request: Extract<WorkspaceDialogRequest, { kind: "new" }> }>();
const open = computed({ get: () => workspaceDialog.open, set: (value) => (workspaceDialog.open = value) });

const form = reactive({ name: "", instructions: "", kind: "private" as "org" | "private" });
const nameError = ref("");
const error = ref("");
const saving = ref(false);

async function save() {
	nameError.value = form.name.trim() ? "" : "Give the workspace a name.";
	if (nameError.value) return;
	saving.value = true;
	error.value = "";
	try {
		const made = await createWorkspace({ name: form.name.trim(), instructions: form.instructions.trim(), kind: isAdmin.value ? form.kind : "private" });
		// No toast: the new workspace's page opens, under its name, and that says it was made.
		props.request.onMade(made.slug);
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
			<FormControl v-model="form.name" label="Name" :placeholder="NAME_PLACEHOLDER" :error="nameError" autofocus />
			<FormControl v-if="isAdmin" v-model="form.kind" type="select" label="Who can use it" :options="KIND_OPTIONS" />
			<FormControl v-model="form.instructions" type="textarea" label="Instructions (optional)" :placeholder="INSTRUCTIONS_PLACEHOLDER" :rows="6" />
			<ErrorMessage v-if="error" :message="error" />
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button type="submit" variant="solid" theme="gray" :loading="saving" label="Create workspace" />
			</div>
		</form>
	</Dialog>
</template>
