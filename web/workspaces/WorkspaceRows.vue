<script setup lang="ts">
import { Button, Dropdown, SidebarItem, SidebarLabel } from "frappe-ui";
import { accessIcon, openWorkspace, pinWorkspace, sharedWith, workspaces, workspacesLoaded, type WorkspaceSummary } from "./store";
import WorkspaceRowsSkeleton from "./WorkspaceRowsSkeleton.vue";

/**
 * The sidebar's workspaces, above the chats (ChatsPanel.vue): the ones the person pinned
 * first, then the newest made first, each with the icon of its kind. Each row has a menu,
 * as a chat row has (ThreadList.vue), with Pin or Unpin; a pinned row moves to the top as
 * a chat does when it is active again. The + makes a new one; with no workspace yet, a
 * "New workspace" row takes its place. WorkspaceRowsPlaceholder.vue draws the same rows
 * while this chunk loads.
 */
const props = defineProps<{ highlight: boolean }>();
const emit = defineEmits<{ select: [slug: string]; create: [] }>();

function menu(workspace: WorkspaceSummary) {
	return workspace.pinned
		? [{ label: "Unpin", icon: "lucide-pin-off", onClick: () => void pinWorkspace(workspace.id, false) }]
		: [{ label: "Pin", icon: "lucide-pin", onClick: () => void pinWorkspace(workspace.id, true) }];
}

const isOpen = (workspace: WorkspaceSummary) => props.highlight && workspace.id === openWorkspace.value?.id;
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
		<!-- A new or newly pinned workspace slides in at the top; the others move down: the chat rows' motion. -->
		<TransitionGroup
			v-else
			tag="div"
			class="relative space-y-0.5"
			leave-active-class="absolute inset-x-0 transition-opacity duration-150 ease-out-strong motion-reduce:transition-none"
			leave-to-class="opacity-0"
			enter-active-class="transition-[opacity,transform] duration-200 ease-out-strong motion-reduce:transition-none"
			enter-from-class="-translate-y-1 opacity-0"
			move-class="transition-transform duration-200 ease-out-strong motion-reduce:transition-none"
		>
			<SidebarItem
				v-for="workspace in workspaces"
				:key="workspace.id"
				class="!h-7 [@media(pointer:coarse)]:!h-11"
				:label="workspace.name"
				:active="isOpen(workspace)"
				:title="`${workspace.name} · ${sharedWith(workspace)}`"
				@click="emit('select', workspace.slug)"
			>
				<template #prefix><span :class="[accessIcon(workspace), 'size-4 text-ink-gray-6']" aria-hidden="true" /></template>
				<template #suffix>
					<Dropdown :options="menu(workspace)" align="end">
						<template #trigger>
							<button
								type="button"
								class="relative flex size-6 items-center justify-center rounded-4 text-ink-gray-5 opacity-0 transition-opacity duration-150 ease-out-strong after:absolute after:-inset-1 after:content-[''] [@media(pointer:coarse)]:after:-inset-2.5 hover:bg-surface-gray-3 hover:text-ink-gray-8 focus-visible:opacity-100 active:bg-surface-gray-4 aria-expanded:opacity-100 data-[state=open]:opacity-100 group-hover/sidebar-item:opacity-100 group-focus-within/sidebar-item:opacity-100 motion-reduce:transition-none [@media(pointer:coarse)]:opacity-100"
								:class="{ 'opacity-100': isOpen(workspace) }"
								:aria-label="`Actions for “${workspace.name}”`"
							>
								<span class="lucide-ellipsis size-4" aria-hidden="true" />
							</button>
						</template>
					</Dropdown>
				</template>
			</SidebarItem>
		</TransitionGroup>
	</section>
</template>
