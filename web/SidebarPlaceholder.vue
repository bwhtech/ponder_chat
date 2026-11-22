<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { me } from "./account";
import BrandLogo from "./BrandLogo.vue";
import { sidebarCollapsed } from "./sidebar";
import ThreadRowsSkeleton from "./ThreadRowsSkeleton.vue";
import WorkspaceRowsPlaceholder from "./workspaces/WorkspaceRowsPlaceholder.vue";

/**
 * The chats panel (ChatsPanel.vue) while its chunk arrives, in the sidebar or in the phone's
 * bottom sheet: the same layout, with the workspaces' rows, and skeleton rows for the chats and the credits, so nothing
 * moves when the panel takes its place. Vue gives it ChatsPanel's props (Shell.vue).
 */
defineOptions({ inheritAttrs: false });
defineProps<{ sheet?: boolean; name: string }>();
</script>

<template>
	<nav v-if="!sheet && sidebarCollapsed" class="hidden h-full flex-shrink-0 flex-col overflow-x-hidden border-r border-outline-gray-1 bg-surface-sidebar md:flex" style="width: 3rem" aria-label="Chats" aria-busy="true">
		<div class="flex h-12 shrink-0 items-center px-1">
			<div class="flex h-10 items-center rounded-4 px-1.5"><div class="size-7 shrink-0 overflow-hidden rounded-[6px]"><BrandLogo class="size-full" /></div></div>
		</div>
		<div class="mt-auto px-2 pb-1">
			<div class="flex h-7 items-center pl-2 [@media(pointer:coarse)]:h-11"><span class="lucide-square-pen size-4 text-ink-gray-6" aria-hidden="true" /></div>
		</div>
		<div class="px-2 pb-2">
			<div class="flex h-7 items-center pl-2 [@media(pointer:coarse)]:h-11"><span class="lucide-panel-right-open size-4 rotate-180 text-ink-gray-6" aria-hidden="true" /></div>
		</div>
	</nav>
	<nav v-else-if="!sheet" class="hidden h-full flex-shrink-0 flex-col overflow-x-hidden border-r border-outline-gray-1 bg-surface-sidebar md:flex" style="width: 16rem" aria-label="Chats" aria-busy="true">
		<!-- frappe-ui's SidebarHeader, drawn without its menu. -->
		<div class="flex h-12 shrink-0 items-center px-1">
			<div class="flex h-10 w-full items-center rounded-4 px-1.5">
				<div class="size-7 shrink-0 overflow-hidden rounded-[6px]"><BrandLogo class="size-full" /></div>
				<div class="ml-2 flex flex-1 flex-col truncate text-left">
					<div class="truncate text-base-medium leading-tighter text-ink-gray-8">Ponder Chat</div>
					<div class="mt-0.5 truncate text-sm leading-tighter text-ink-gray-6">{{ name }}</div>
				</div>
				<div class="ml-2"><span class="lucide-chevron-down size-4 text-ink-gray-7" aria-hidden="true" /></div>
			</div>
		</div>
		<div class="flex min-h-0 flex-1 flex-col px-2">
			<div class="flex min-h-0 flex-1 flex-col gap-4">
				<div class="shrink-0 pt-2">
					<!-- The search field (frappe-ui's TextInput), not yet usable. -->
					<div class="relative flex h-7 w-full items-center rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 pe-2 ps-8 text-base text-ink-gray-4">
						<span class="lucide-search absolute start-2 size-4 text-ink-gray-5" aria-hidden="true" />
						Search chats
					</div>
				</div>
				<div class="-mx-2 flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-2 pb-3"><WorkspaceRowsPlaceholder /><ThreadRowsSkeleton /></div>
			</div>
		</div>
		<div class="px-2 pb-3 pt-3">
			<Button variant="outline" size="md" icon-left="lucide-square-pen" class="w-full !justify-start !px-2 bg-surface-base" disabled>New chat</Button>
		</div>
		<div v-if="me" class="px-2 pb-2">
			<!-- CreditMeter's frame: its label, with bars for the numbers. -->
			<div class="flex flex-col gap-1.5 rounded-7 px-2 py-2">
				<div class="flex items-center justify-between gap-2 text-p-sm">
					<span class="text-ink-gray-6">Credits left</span>
					<span class="flex h-[1lh] items-center"><Skeleton class="h-3 w-14 rounded-4" /></span>
				</div>
				<div class="h-1 rounded-full bg-surface-gray-3" />
				<span class="flex h-[1lh] items-center text-p-xs"><Skeleton class="h-2.5 w-28 rounded-4" /></span>
			</div>
		</div>
		<div class="px-2 pb-2">
			<div class="flex h-7 items-center pl-2 text-ink-gray-6 [@media(pointer:coarse)]:h-11">
				<span class="lucide-panel-right-open size-4" aria-hidden="true" />
				<span class="ml-2 truncate text-sm leading-tighter">Collapse</span>
			</div>
		</div>
	</nav>
	<div v-else class="flex flex-col gap-2 px-2 pb-[max(1rem,env(safe-area-inset-bottom))]" aria-busy="true">
		<div class="-mx-1 -mt-2 flex h-12 shrink-0 items-center px-1">
			<div class="flex h-10 w-full items-center rounded-4 px-1.5">
				<div class="size-7 shrink-0 overflow-hidden rounded-[6px]"><BrandLogo class="size-full" /></div>
				<div class="ml-2 flex flex-1 flex-col truncate text-left">
					<div class="truncate text-base-medium leading-tighter text-ink-gray-8">Ponder Chat</div>
					<div class="mt-0.5 truncate text-sm leading-tighter text-ink-gray-6">{{ name }}</div>
				</div>
				<div class="ml-2"><span class="lucide-chevron-down size-4 text-ink-gray-7" aria-hidden="true" /></div>
			</div>
		</div>
		<Button variant="outline" size="md" icon-left="lucide-square-pen" class="w-full !justify-start !px-2 bg-surface-base" disabled>New chat</Button>
		<div class="flex flex-col gap-4">
			<div class="shrink-0 pt-2">
				<div class="relative flex h-7 w-full items-center rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 pe-2 ps-8 text-base text-ink-gray-4">
					<span class="lucide-search absolute start-2 size-4 text-ink-gray-5" aria-hidden="true" />
					Search chats
				</div>
			</div>
			<div class="flex flex-col gap-4"><WorkspaceRowsPlaceholder /><ThreadRowsSkeleton /></div>
		</div>
		<div v-if="me" class="border-t border-outline-gray-1 pt-2">
			<div class="flex flex-col gap-1.5 rounded-7 px-2 py-2">
				<div class="flex items-center justify-between gap-2 text-p-sm">
					<span class="text-ink-gray-6">Credits left</span>
					<span class="flex h-[1lh] items-center"><Skeleton class="h-3 w-14 rounded-4" /></span>
				</div>
				<div class="h-1 rounded-full bg-surface-gray-3" />
				<span class="flex h-[1lh] items-center text-p-xs"><Skeleton class="h-2.5 w-28 rounded-4" /></span>
			</div>
		</div>
	</div>
</template>
