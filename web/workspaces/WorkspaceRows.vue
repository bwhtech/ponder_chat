<script setup lang="ts">
import { Button, SidebarItem, SidebarLabel } from "frappe-ui";
import { kindIcon, openWorkspace, sharedWith, workspaces, workspacesLoaded } from "./store";
import WorkspaceRowsSkeleton from "./WorkspaceRowsSkeleton.vue";

/**
 * The sidebar's workspaces, above the chats (ChatsPanel.vue): organisation ones first, then
 * the ones shared with the person, then their own, each with the icon of its kind. The +
 * makes a new one; with no workspace yet, a "New workspace" row takes its place.
 * WorkspaceRowsPlaceholder.vue draws the same rows while this chunk loads.
 */
defineProps<{ highlight: boolean }>();
const emit = defineEmits<{ select: [slug: string]; create: [] }>();
</script>

<template>
	<section aria-label="Workspaces" class="space-y-0.5" data-slot="workspace-rows">
		<div class="flex h-7 items-center justify-between">
			<SidebarLabel class="[&_h3]:text-xs-medium [&_h3]:text-ink-gray-6">Workspaces</SidebarLabel>
			<Button
				v-if="workspaces.length"
				variant="ghost"
				icon="lucide-plus"
				aria-label="New workspace"
				class="touch-target !text-ink-gray-6 hover:!text-ink-gray-8"
				@click="emit('create')"
			/>
		</div>
		<WorkspaceRowsSkeleton v-if="!workspacesLoaded" />
		<SidebarItem v-else-if="!workspaces.length" class="!h-7 [@media(pointer:coarse)]:!h-11" label="New workspace" data-slot="workspace-new" @click="emit('create')">
			<template #prefix><span class="lucide-plus size-4 text-ink-gray-6" aria-hidden="true" /></template>
		</SidebarItem>
		<template v-else>
			<SidebarItem
				v-for="workspace in workspaces"
				:key="workspace.id"
				class="!h-7 [@media(pointer:coarse)]:!h-11"
				:label="workspace.name"
				:active="highlight && workspace.id === openWorkspace?.id"
				:title="`${workspace.name} · ${sharedWith(workspace)}`"
				@click="emit('select', workspace.slug)"
			>
				<template #prefix><span :class="[kindIcon(workspace), 'size-4 text-ink-gray-6']" aria-hidden="true" /></template>
			</SidebarItem>
		</template>
	</section>
</template>
