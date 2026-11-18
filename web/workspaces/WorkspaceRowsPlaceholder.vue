<script setup lang="ts">
import { accessIcon, workspaces, workspacesLoaded } from "./store";
import WorkspaceRowsSkeleton from "./WorkspaceRowsSkeleton.vue";

/**
 * The sidebar's workspaces (WorkspaceRows.vue) while the chats panel loads: the same label,
 * + and rows, drawn without frappe-ui's sidebar code. The list comes with the page, so the
 * rows show their names at once; nothing moves when the panel takes their place.
 */
</script>

<template>
	<div class="space-y-0.5" data-slot="workspace-rows-placeholder">
		<div class="flex h-7 items-center justify-between">
			<div class="flex h-7 items-center pl-2"><h3 class="text-xs-medium leading-tighter text-ink-gray-6">Workspaces</h3></div>
			<span v-if="workspaces.length" class="flex size-7 items-center justify-center text-ink-gray-6"><span class="lucide-plus size-4" aria-hidden="true" /></span>
		</div>
		<WorkspaceRowsSkeleton v-if="!workspacesLoaded" />
		<div v-else-if="!workspaces.length" class="flex h-7 items-center rounded-4 pl-2 text-ink-gray-6 [@media(pointer:coarse)]:h-11">
			<span class="lucide-plus size-4 shrink-0" aria-hidden="true" />
			<span class="ml-2 truncate text-sm leading-tighter">New workspace</span>
		</div>
		<template v-else>
			<div v-for="workspace in workspaces" :key="workspace.id" class="flex h-7 items-center rounded-4 pl-2 pr-6 text-ink-gray-6 [@media(pointer:coarse)]:h-11">
				<span :class="[accessIcon(workspace), 'size-4 shrink-0']" aria-hidden="true" />
				<span class="ml-2 truncate text-sm leading-tighter">{{ workspace.name }}</span>
				<span v-if="workspace.pinned" class="lucide-pin ml-1.5 size-3.5 shrink-0 text-ink-gray-4" aria-hidden="true" />
			</div>
		</template>
	</div>
</template>
