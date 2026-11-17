<script setup lang="ts">
import { Button, Dialog, ErrorMessage, FormControl } from "frappe-ui";
import { computed, ref } from "vue";
import { toast } from "../toasts";
import { dialogTitle, KIND_OPTIONS, workspaceDialog, type WorkspaceDialogRequest } from "./dialogs";
import PeoplePicker from "./PeoplePicker.vue";
import { isAdmin, shareWorkspace, type Member } from "./store";

/**
 * Share: who can use the workspace. The owner adds people one by one, each able to ask or to
 * ask and edit. An admin can also make it a workspace for everyone, which keeps no members:
 * everyone asks in it, and admins edit it.
 */
const props = defineProps<{ request: Extract<WorkspaceDialogRequest, { kind: "share" }> }>();
const open = computed({ get: () => workspaceDialog.open, set: (value) => (workspaceDialog.open = value) });
const workspace = props.request.workspace;

const kind = ref(workspace.kind);
const members = ref<Member[]>((workspace.members ?? []).map((member: Member) => ({ ...member })));
const error = ref("");
const saving = ref(false);

async function save() {
	saving.value = true;
	error.value = "";
	try {
		const shared = members.value.map((member) => ({ userId: member.id, access: member.access }));
		const saved = await shareWorkspace(workspace.id, kind.value, kind.value === "org" ? [] : shared);
		props.request.onSaved(saved);
		toast.success("Sharing saved");
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
		<div class="space-y-4">
			<FormControl v-if="isAdmin" v-model="kind" type="select" label="Who can use it" :options="KIND_OPTIONS" />
			<PeoplePicker v-if="kind === 'private'" v-model="members" :owner="workspace.owner" />
			<ErrorMessage v-if="error" :message="error" />
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button variant="solid" theme="gray" label="Save" :loading="saving" @click="save" />
			</div>
		</div>
	</Dialog>
</template>
