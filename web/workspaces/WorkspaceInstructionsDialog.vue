<script setup lang="ts">
import { Button, Dialog, ErrorMessage } from "frappe-ui";
import { computed, ref, shallowRef } from "vue";
import { MAX_INSTRUCTIONS } from "../../shared/workspaces";
import MarkdownEditorPlaceholder from "../MarkdownEditorPlaceholder.vue";
import { count } from "../numbers";
import { toast } from "../toasts";
import { dialogTitle, INSTRUCTIONS_DIALOG_SIZE, INSTRUCTIONS_PLACEHOLDER, workspaceDialog, type WorkspaceDialogRequest } from "./dialogs";
import { updateWorkspace } from "./store";

/**
 * A workspace's instructions, on their own, in the Markdown editor that skills use in /admin:
 * from "Add instructions" while there are none, or the instructions' box once there are
 * (WorkspaceInstructions.vue). Saving changes only the instructions; empty ones clear them.
 */
const props = defineProps<{ request: Extract<WorkspaceDialogRequest, { kind: "instructions" }> }>();
const open = computed({ get: () => workspaceDialog.open, set: (value) => (workspaceDialog.open = value) });

const instructions = ref(props.request.workspace.instructions);
const changed = computed(() => instructions.value.trim() !== props.request.workspace.instructions.trim());
const tooLong = computed(() => instructions.value.trim().length > MAX_INSTRUCTIONS);
const error = ref("");
const saving = ref(false);

// CodeMirror is large, so it comes with this dialog, not with the page. Until it is here, a box
// of the same size shows the text.
const MarkdownEditor = shallowRef<typeof import("../MarkdownEditor.vue").default>();
function loadEditor() {
	error.value = "";
	import("../MarkdownEditor.vue").then(
		(module) => (MarkdownEditor.value = module.default),
		() => (error.value = "The editor could not load. Check your connection, then open the instructions again."),
	);
}
loadEditor();

async function save() {
	if (!changed.value || tooLong.value) return;
	saving.value = true;
	error.value = "";
	try {
		props.request.onSaved(await updateWorkspace(props.request.workspace.id, { instructions: instructions.value.trim() }));
		if (!props.request.quiet) toast.success("Instructions saved");
		open.value = false;
	} catch (failure) {
		error.value = failure instanceof Error ? failure.message : String(failure);
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<Dialog v-model:open="open" :title="dialogTitle(request)" :size="INSTRUCTIONS_DIALOG_SIZE">
		<form class="space-y-4" @submit.prevent="save">
			<!-- `autofocus` tells the Dialog that the field takes the focus; the editor does it once it mounts. -->
			<div class="h-[min(22rem,55dvh)]" autofocus>
				<component :is="MarkdownEditor" v-if="MarkdownEditor" v-model="instructions" :placeholder="INSTRUCTIONS_PLACEHOLDER" autofocus class="h-full" />
				<MarkdownEditorPlaceholder v-else :text="instructions" :placeholder="INSTRUCTIONS_PLACEHOLDER" />
			</div>
			<ErrorMessage v-if="tooLong" :message="`Make the instructions ${count(MAX_INSTRUCTIONS)} characters or fewer. They are ${count(instructions.trim().length)} now.`" />
			<ErrorMessage v-else-if="error" :message="error" />
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button type="submit" variant="solid" theme="gray" :loading="saving" :disabled="!changed || tooLong" label="Save" />
			</div>
		</form>
	</Dialog>
</template>
