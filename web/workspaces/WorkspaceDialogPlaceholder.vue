<script setup lang="ts">
import { Button } from "frappe-ui";
import { computed } from "vue";
import DialogFrame from "../DialogFrame.vue";
import { closeWorkspaceDialog, dialogTitle, workspaceDialog } from "./dialogs";
import { isAdmin } from "./store";

/**
 * A workspace dialog (WorkspaceDialogs.vue) while its code arrives: the same box, title,
 * field labels and buttons, with the values it opens with, so the dialog takes its place
 * without a move. Save waits for it; Cancel works. The markup copies frappe-ui's Dialog
 * and FormControl, as DialogPlaceholder.vue does.
 */
const request = computed(() => workspaceDialog.request);
const form = computed(() => {
	const value = request.value;
	if (!value || value.kind === "share") return null;
	const workspace = value.kind === "edit" ? value.workspace : null;
	return { name: workspace?.name ?? "", description: workspace?.description ?? "", instructions: workspace?.instructions ?? "", kind: value.kind === "new" && isAdmin.value };
});
</script>

<template>
	<DialogFrame v-if="workspaceDialog.open && request" :label="dialogTitle(request)" size="max-w-lg" @close="closeWorkspaceDialog">
		<div class="bg-surface-elevation-1 px-4 pb-6 pt-5 sm:px-6">
			<div class="mb-6 flex items-center justify-between">
				<header class="flex-1">
					<h3 class="text-2xl-semibold leading-6 text-ink-gray-8">{{ dialogTitle(request) }}</h3>
				</header>
				<Button variant="ghost" label="Close" @click="closeWorkspaceDialog">
					<template #icon><span class="lucide-x size-4 text-ink-gray-9" /></template>
				</Button>
			</div>
			<div class="space-y-4">
				<template v-if="form">
					<div class="space-y-1.5">
						<div class="text-sm leading-tighter text-ink-gray-6">Name<span class="ml-1 text-ink-red-5" aria-hidden="true">*</span></div>
						<div class="flex h-7 items-center truncate rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base text-ink-gray-8">{{ form.name }}</div>
					</div>
					<div class="space-y-1.5">
						<div class="text-sm leading-tighter text-ink-gray-6">What is it for?</div>
						<div class="flex h-7 items-center truncate rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base text-ink-gray-8">{{ form.description }}</div>
						<p class="text-p-sm text-ink-gray-6">Shown on the workspace page.</p>
					</div>
					<div v-if="form.kind" class="space-y-1.5">
						<div class="text-sm leading-tighter text-ink-gray-6">Who can use it</div>
						<div class="flex h-7 items-center rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base text-ink-gray-8">Only the people you add</div>
					</div>
					<div class="space-y-1.5">
						<div class="text-sm leading-tighter text-ink-gray-6">Instructions</div>
						<div class="h-[calc(6lh+0.875rem)] overflow-hidden whitespace-pre-wrap break-words rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 py-1.5 text-p-sm text-ink-gray-8">{{ form.instructions }}</div>
						<p class="text-p-sm text-ink-gray-6">Every chat in this workspace follows these.</p>
					</div>
				</template>
				<template v-else>
					<div class="flex h-7 items-center rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base text-ink-gray-4">Add people by name or email</div>
				</template>
				<div class="flex justify-end gap-2 pt-2">
					<Button label="Cancel" @click="closeWorkspaceDialog" />
					<Button variant="solid" theme="gray" :label="request.kind === 'new' ? 'Create workspace' : 'Save'" disabled />
				</div>
			</div>
		</div>
	</DialogFrame>
</template>
