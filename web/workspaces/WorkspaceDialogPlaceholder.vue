<script setup lang="ts">
import { Button } from "frappe-ui";
import { displayName } from "../../shared/display-name";
import { computed } from "vue";
import { me } from "../account";
import DialogFrame from "../DialogFrame.vue";
import MarkdownEditorPlaceholder from "../MarkdownEditorPlaceholder.vue";
import ShareRow from "./ShareRow.vue";
import {
	ADD_PEOPLE,
	closeWorkspaceDialog,
	dialogTitle,
	GENERAL_ACCESS,
	generalAccessNote,
	INSTRUCTIONS_DIALOG_WIDTH,
	INSTRUCTIONS_PLACEHOLDER,
	NAME_PLACEHOLDER,
	ROLE_LABELS,
	workspaceDialog,
} from "./dialogs";
import type { Member, Person } from "./store";

/**
 * A workspace dialog (WorkspaceDialogs.vue) while its code arrives: the same box, title,
 * field labels and buttons, with the values it opens with, so the dialog takes its place
 * without a move. Save and Copy link wait for it; Cancel and Done work. The markup copies
 * frappe-ui's Dialog, FormControl and ghost Button, as DialogPlaceholder.vue does.
 */
const request = computed(() => workspaceDialog.request);
/** New workspace: its empty form. */
const form = computed(() => request.value?.kind === "new");
/** Instructions: the text the dialog opens with. */
const instructions = computed(() => (request.value?.kind === "instructions" ? request.value.workspace.instructions : null));
/** Share: its people and General access, as ShareDialog.vue draws them, with each menu as its text. */
const sharing = computed(() => {
	const value = request.value;
	if (value?.kind !== "share") return null;
	const workspace = value.workspace;
	return {
		owner: workspace.owner as Person,
		members: (workspace.members ?? []) as Member[],
		orgAccess: workspace.orgAccess,
		canChange: workspace.canChangeOrgAccess,
	};
});
const myId = computed(() => me.value?.user.id);
const myName = computed(() => (me.value ? displayName(me.value.user.name, me.value.user.email) : "You"));
const nameOf = (person: Person) => displayName(person.name, person.email);
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
					<div class="flex h-7 items-center rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base text-ink-gray-4">{{ ADD_PEOPLE }}</div>
					<section class="space-y-1">
						<div class="flex h-7 items-center text-sm text-ink-gray-6">People with access</div>
						<ul>
							<ShareRow
								:avatar="nameOf(sharing.owner)"
								:name="sharing.owner.id === myId ? 'You' : nameOf(sharing.owner)"
								:email="sharing.owner.id === myId ? undefined : sharing.owner.email"
								owner
							/>
							<ShareRow
								v-for="member in sharing.members"
								:key="member.id"
								:avatar="member.id === myId ? myName : nameOf(member)"
								:name="member.id === myId ? 'You' : nameOf(member)"
								:email="member.id === myId ? undefined : member.email"
							>
								<!-- The role menu's ghost button. -->
								<span class="flex h-7 w-28 items-center justify-between gap-2 rounded-4 px-2 text-base text-ink-gray-8">
									{{ ROLE_LABELS[member.access] }}<span class="lucide-chevron-down size-4 shrink-0" aria-hidden="true" />
								</span>
							</ShareRow>
						</ul>
					</section>
					<section class="space-y-1">
						<div class="flex h-7 items-center text-sm text-ink-gray-6">General access</div>
						<div class="flex items-start gap-x-2.5">
							<span class="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-gray-2 text-ink-gray-6" aria-hidden="true">
								<span :class="[GENERAL_ACCESS[sharing.orgAccess].icon, 'size-3']" />
							</span>
							<div class="min-w-0 flex-1">
								<span v-if="sharing.canChange" class="-ml-2 inline-flex h-7 items-center gap-2 rounded-4 px-2 text-base text-ink-gray-8">
									{{ GENERAL_ACCESS[sharing.orgAccess].label }}<span class="lucide-chevron-down size-4 shrink-0" aria-hidden="true" />
								</span>
								<p v-else class="flex h-7 items-center text-base text-ink-gray-8">{{ GENERAL_ACCESS[sharing.orgAccess].label }}</p>
								<p class="text-p-sm text-ink-gray-6">{{ generalAccessNote(sharing.orgAccess, sharing.canChange) }}</p>
							</div>
							<span v-if="sharing.orgAccess === 'ask'" class="hidden h-7 w-28 shrink-0 items-center px-2 text-base text-ink-gray-6 sm:flex">Can ask</span>
						</div>
					</section>
				</template>
				<div v-if="sharing" class="flex items-center justify-between gap-2 pt-2">
					<Button icon-left="lucide-link" label="Copy link" disabled />
					<Button variant="solid" theme="gray" label="Done" @click="closeWorkspaceDialog" />
				</div>
				<div v-else class="flex justify-end gap-2 pt-2">
					<Button label="Cancel" @click="closeWorkspaceDialog" />
					<Button variant="solid" theme="gray" :label="request.kind === 'new' ? 'Create workspace' : 'Save'" disabled />
				</div>
			</div>
		</div>
	</DialogFrame>
</template>
