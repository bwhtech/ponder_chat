<script setup lang="ts">
import { Button, SidebarItem, SidebarLabel } from "frappe-ui";
import { kindIcon, openWorkspaceId, sharedWith, workspaces, workspacesLoaded } from "./store";
import WorkspaceRowsSkeleton from "./WorkspaceRowsSkeleton.vue";

/**
 * The sidebar's workspaces, above the chats (ChatsPanel.vue): organisation ones first, then
 * the ones shared with the person, then their own, each with the icon of its kind. The +
 * makes a new one. SidebarPlaceholder.vue draws the same rows while this chunk loads.
 */
defineProps<{ highlight: boolean }>();
const emit = defineEmits<{ select: [id: string]; create: [] }>();
</script>

<template>
	<section aria-label="Workspaces" class="space-y-0.5" data-slot="workspace-rows">
		<div class="flex items-center justify-between">
			<SidebarLabel class="[&_h3]:text-xs-medium [&_h3]:text-ink-gray-6">Workspaces</SidebarLabel>
			<Button variant="ghost" icon="lucide-plus" aria-label="New workspace" class="touch-target !text-ink-gray-6 hover:!text-ink-gray-8" @click="emit('create')" />
		</div>
		<WorkspaceRowsSkeleton v-if="!workspacesLoaded" />
		<template v-else>
			<SidebarItem
				v-for="workspace in workspaces"
				:key="workspace.id"
				class="!h-7 [@media(pointer:coarse)]:!h-11"
				:label="workspace.name"
				:active="highlight && workspace.id === openWorkspaceId"
				:title="`${workspace.name} · ${sharedWith(workspace)}`"
				@click="emit('select', workspace.id)"
			>
				<template #prefix><span :class="[kindIcon(workspace), 'size-4 text-ink-gray-6']" aria-hidden="true" /></template>
			</SidebarItem>
			<p v-if="!workspaces.length" class="px-2 text-p-sm text-ink-gray-6">Keep instructions for a topic, and share them, in a workspace.</p>
		</template>
	</section>
</template>
