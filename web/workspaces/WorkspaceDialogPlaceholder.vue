<script setup lang="ts">
import { Avatar, Button, Skeleton } from "frappe-ui";
import { displayName } from "../../shared/display-name";
import { computed } from "vue";
import { me } from "../account";
import DialogFrame from "../DialogFrame.vue";
import { closeWorkspaceDialog, DESCRIPTION_PLACEHOLDER, dialogTitle, INSTRUCTIONS_PLACEHOLDER, KIND_OPTIONS, NAME_PLACEHOLDER, workspaceDialog } from "./dialogs";
import { isAdmin, type Member, type Person } from "./store";

/**
 * A workspace dialog (WorkspaceDialogs.vue) while its code arrives: the same box, title,
 * field labels and buttons, with the values it opens with, so the dialog takes its place
 * without a move. Save waits for it; Cancel works. The markup copies frappe-ui's Dialog
 * and FormControl, as DialogPlaceholder.vue does.
 */
const request = computed(() => workspaceDialog.request);
const form = computed(() => {
	const value = request.value;
	if (!value || value.kind === "share" || value.kind === "document") return null;
	const workspace = value.kind === "edit" ? value.workspace : null;
	return { name: workspace?.name ?? "", description: workspace?.description ?? "", instructions: workspace?.instructions ?? "", kind: value.kind === "new" && isAdmin.value };
});
const sharing = computed(() => {
	const value = request.value;
	if (value?.kind !== "share") return null;
	const kind = KIND_OPTIONS.find((option) => option.value === value.workspace.kind)?.label ?? "";
	return { kind, private: value.workspace.kind === "private", owner: value.workspace.owner as Person, members: (value.workspace.members ?? []) as Member[] };
});
const ACCESS_LABELS = { ask: "Can ask", edit: "Can edit" } as const;
const nameOf = (person: Person) => displayName(person.name, person.email);
const shownName = (person: Person) => (person.id === sharing.value?.owner.id && person.id === me.value?.user.id ? "You" : nameOf(person));
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
						<div class="text-sm leading-tighter text-ink-gray-6">Name</div>
						<div class="flex h-7 items-center truncate rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base" :class="form.name ? 'text-ink-gray-8' : 'text-ink-gray-4'">{{ form.name || NAME_PLACEHOLDER }}</div>
					</div>
					<div class="space-y-1.5">
						<div class="text-sm leading-tighter text-ink-gray-6">Description (optional)</div>
						<div
							class="h-[calc(2lh+0.875rem)] overflow-hidden whitespace-pre-wrap break-words rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 py-1.5 text-p-sm"
							:class="form.description ? 'text-ink-gray-8' : 'text-ink-gray-4'"
						>{{ form.description || DESCRIPTION_PLACEHOLDER }}</div>
					</div>
					<div v-if="form.kind" class="space-y-1.5">
						<div class="text-sm leading-tighter text-ink-gray-6">Who can use it</div>
						<div class="flex h-7 items-center rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base text-ink-gray-8">Only the people you add</div>
					</div>
					<div class="space-y-1.5">
						<div class="text-sm leading-tighter text-ink-gray-6">Instructions (optional)</div>
						<div
							class="h-[calc(6lh+0.875rem)] overflow-hidden whitespace-pre-wrap break-words rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 py-1.5 text-p-sm"
							:class="form.instructions ? 'text-ink-gray-8' : 'text-ink-gray-4'"
						>{{ form.instructions || INSTRUCTIONS_PLACEHOLDER }}</div>
					</div>
				</template>
				<template v-else-if="request.kind === 'document'">
					<ol class="space-y-3" aria-busy="true">
						<li v-for="width in ['w-36', 'w-44', 'w-20']" :key="width" class="flex h-[1lh] items-center text-sm"><Skeleton :class="['h-3 rounded-4', width]" /></li>
					</ol>
				</template>
				<template v-else-if="sharing">
					<div v-if="isAdmin" class="space-y-1.5">
						<div class="text-sm leading-tighter text-ink-gray-6">Who can use it</div>
						<div class="flex h-7 items-center rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base text-ink-gray-8">{{ sharing.kind }}</div>
					</div>
					<div v-if="sharing.private" class="space-y-2">
						<div class="flex h-7 items-center rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base text-ink-gray-4">Add people by name or email</div>
						<!-- PeoplePicker.vue's rows, with what each can do as text. -->
						<ul>
							<li v-for="person in [sharing.owner, ...sharing.members]" :key="person.id" class="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1.5 sm:h-8 sm:flex-nowrap sm:py-0">
								<Avatar :label="nameOf(person)" size="sm" class="shrink-0" />
								<p class="min-w-0 flex-1 text-sm sm:truncate">
									<span class="text-ink-gray-8">{{ shownName(person) }}</span>
									<span class="ml-1.5 break-all text-ink-gray-6">{{ person.email }}</span>
								</p>
								<div class="flex basis-full items-center gap-2.5 pl-[1.875rem] sm:basis-auto sm:pl-0 [@media(pointer:coarse)]:gap-x-4">
									<span class="flex h-7 w-28 shrink-0 items-center border border-transparent px-2 text-sm text-ink-gray-6">{{ "access" in person ? ACCESS_LABELS[(person as Member).access] : "Owner" }}</span>
									<span class="size-7 shrink-0" aria-hidden="true" />
								</div>
							</li>
						</ul>
					</div>
				</template>
				<div v-if="request.kind === 'document'" class="flex justify-end gap-2 pt-2">
					<Button label="Close" @click="closeWorkspaceDialog" />
				</div>
				<div v-else class="flex justify-end gap-2 pt-2">
					<Button label="Cancel" @click="closeWorkspaceDialog" />
					<Button variant="solid" theme="gray" :label="request.kind === 'new' ? 'Create workspace' : 'Save'" disabled />
				</div>
			</div>
		</div>
	</DialogFrame>
</template>
