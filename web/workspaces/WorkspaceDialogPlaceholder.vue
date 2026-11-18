<script setup lang="ts">
import { Button } from "frappe-ui";
import { displayName } from "../../shared/display-name";
import { computed } from "vue";
import { me } from "../account";
import DialogFrame from "../DialogFrame.vue";
import MarkdownEditorPlaceholder from "../MarkdownEditorPlaceholder.vue";
import ShareRow from "./ShareRow.vue";
import { closeWorkspaceDialog, dialogTitle, INSTRUCTIONS_DIALOG_WIDTH, INSTRUCTIONS_PLACEHOLDER, KIND_OPTIONS, NAME_PLACEHOLDER, workspaceDialog } from "./dialogs";
import { isAdmin, type Member, type Person } from "./store";

/**
 * A workspace dialog (WorkspaceDialogs.vue) while its code arrives: the same box, title,
 * field labels and buttons, with the values it opens with, so the dialog takes its place
 * without a move. Save waits for it; Cancel works. The markup copies frappe-ui's Dialog
 * and FormControl, as DialogPlaceholder.vue does.
 */
const request = computed(() => workspaceDialog.request);
/** New workspace: its empty form. */
const form = computed(() => (request.value?.kind === "new" ? { kind: isAdmin.value } : null));
/** Instructions: the text the dialog opens with. */
const instructions = computed(() => (request.value?.kind === "instructions" ? request.value.workspace.instructions : null));
const sharing = computed(() => {
	const value = request.value;
	if (value?.kind !== "share") return null;
	const kind = KIND_OPTIONS.find((option) => option.value === value.workspace.kind)?.label ?? "";
	return { kind, private: value.workspace.kind === "private", owner: value.workspace.owner as Person, members: (value.workspace.members ?? []) as Member[] };
});
const ACCESS_LABELS = { ask: "Can ask", edit: "Can edit" } as const;
const nameOf = (person: Person) => displayName(person.name, person.email);
const ownerIsMe = computed(() => sharing.value?.owner.id === me.value?.user.id);
</script>

<template>
	<DialogFrame v-if="workspaceDialog.open && request" :label="dialogTitle(request)" :size="request.kind === 'instructions' ? INSTRUCTIONS_DIALOG_WIDTH : 'max-w-lg'" @close="closeWorkspaceDialog">
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
						<div class="text-sm leading-tighter text-ink-gray-6">Name</div>
						<div class="flex h-7 items-center truncate rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base text-ink-gray-4">{{ NAME_PLACEHOLDER }}</div>
					</div>
					<div v-if="form.kind" class="space-y-1.5">
						<div class="text-sm leading-tighter text-ink-gray-6">Who can use it</div>
						<div class="flex h-7 items-center rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base text-ink-gray-8">Only the people you add</div>
					</div>
					<div class="space-y-1.5">
						<div class="text-sm leading-tighter text-ink-gray-6">Instructions (optional)</div>
						<div class="h-[calc(6lh+0.875rem)] overflow-hidden rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 py-1.5 text-p-sm text-ink-gray-4">{{ INSTRUCTIONS_PLACEHOLDER }}</div>
					</div>
				</template>
				<!-- The Instructions dialog's one field, its Markdown editor. -->
				<div v-else-if="instructions !== null" class="h-[min(22rem,55dvh)]">
					<MarkdownEditorPlaceholder :text="instructions" :placeholder="INSTRUCTIONS_PLACEHOLDER" />
				</div>
				<template v-else-if="sharing">
					<div v-if="isAdmin" class="space-y-1.5">
						<div class="text-sm leading-tighter text-ink-gray-6">Who can use it</div>
						<div class="flex h-7 items-center rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base text-ink-gray-8">{{ sharing.kind }}</div>
					</div>
					<div v-if="sharing.private" class="space-y-2">
						<div class="flex h-7 items-center rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base text-ink-gray-4">Add people by name or email</div>
						<!-- PeoplePicker.vue's rows, with what each can do as text. -->
						<ul>
							<ShareRow :avatar="nameOf(sharing.owner)" :name="ownerIsMe ? 'You' : nameOf(sharing.owner)" :email="ownerIsMe ? undefined : sharing.owner.email" owner />
							<ShareRow v-for="member in sharing.members" :key="member.id" :avatar="nameOf(member)" :name="nameOf(member)" :email="member.email">
								<span class="flex h-7 w-28 shrink-0 items-center border border-transparent px-2 text-sm text-ink-gray-6">{{ ACCESS_LABELS[member.access] }}</span>
								<span class="size-7 shrink-0" aria-hidden="true" />
							</ShareRow>
						</ul>
					</div>
				</template>
				<div class="flex justify-end gap-2 pt-2">
					<Button label="Cancel" @click="closeWorkspaceDialog" />
					<Button variant="solid" theme="gray" :label="request.kind === 'new' ? 'Create workspace' : 'Save'" disabled />
				</div>
			</div>
		</div>
	</DialogFrame>
</template>
