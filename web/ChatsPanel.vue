<script setup lang="ts">
import { Button, Dropdown, Sidebar, SidebarHeader, SidebarItem, Tooltip, type DropdownOptions } from "frappe-ui";
import { me } from "./account";
import BrandLogo from "./BrandLogo.vue";
import CreditMeter from "./CreditMeter.vue";
import { setSidebarCollapsed, sidebarCollapsed } from "./sidebar";
import ThreadList from "./ThreadList.vue";
import WorkspaceRows from "./workspaces/WorkspaceRows.vue";

/**
 * The chats: the account menu, the workspaces and the chats, New chat and the credits. A
 * sidebar on a wide screen, or the content of the bottom sheet on a phone (`sheet`). Its own
 * chunk: a phone draws it only when the sheet opens, and a wide screen fetches it beside the
 * page's first code (server/boot-page.ts), so it does not wait for it (Shell.vue).
 * `highlight` marks the open chat; `highlightWorkspace` the open workspace page.
 */
defineProps<{ sheet?: boolean; name: string; menu: DropdownOptions; highlight: boolean; highlightWorkspace: boolean }>();
const emit = defineEmits<{ select: [id: string]; newChat: []; selectWorkspace: [id: string]; newWorkspace: [] }>();
</script>

<template>
	<Sidebar
		v-if="!sheet"
		:collapsible="false"
		class="hidden border-r border-outline-gray-1 !duration-200 !ease-out-strong motion-reduce:!transition-none md:flex"
		:width="sidebarCollapsed ? '3rem' : '16rem'"
		aria-label="Chats"
	>
		<div class="relative min-h-0 flex-1 overflow-clip">
			<!-- Stays laid out at full width while folded: the list keeps its scroll and search, and its text never rewraps as the width moves.
			     Only the width animates: frappe-ui's own collapse runs a transition on every row, which outlasts the width and flickers. -->
			<div class="absolute inset-y-0 left-0 flex w-[calc(16rem-1px)] flex-col" :class="{ 'opacity-0': sidebarCollapsed }" :inert="sidebarCollapsed">
				<SidebarHeader title="Ponder Chat" :subtitle="name" :logo="BrandLogo" :menu-items="menu" />
				<div class="flex min-h-0 flex-1 flex-col px-2">
					<ThreadList scroll :highlight="highlight" @select="emit('select', $event)">
						<WorkspaceRows :highlight="highlightWorkspace" @select="emit('selectWorkspace', $event)" @create="emit('newWorkspace')" />
					</ThreadList>
				</div>
				<!-- The main action, under the list: always in the same place, however long the list grows.
				     Its content starts on the sidebar's edges, like the search field: icon at 16px, label at 40px. -->
				<div class="px-2 pb-3 pt-3">
					<Button variant="outline" size="md" icon-left="lucide-square-pen" class="w-full !justify-start !px-2 bg-surface-base transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out-strong active:scale-[0.98] motion-reduce:transform-none" @click="emit('newChat')">New chat</Button>
				</div>
				<div v-if="me" class="px-2 pb-2">
					<CreditMeter :credits="me.credits" />
				</div>
			</div>
			<!-- SidebarHeader's menu takes its trigger's width, too narrow on the rail, so the rail opens its own. -->
			<div v-if="sidebarCollapsed" class="absolute inset-y-0 left-0 flex w-[calc(3rem-1px)] flex-col">
				<div class="flex h-12 shrink-0 items-center px-1">
					<Dropdown :options="menu">
						<button type="button" aria-label="Account menu" class="touch-target flex h-10 items-center rounded-4 px-1.5 hover:bg-surface-gray-3 focus-visible:ring-0 focus-visible:focus-ring">
							<span class="block size-7 shrink-0 overflow-hidden rounded-[6px]"><BrandLogo class="size-full" /></span>
						</button>
					</Dropdown>
				</div>
				<div class="mt-auto px-2 pb-1">
					<SidebarItem class="!h-7 [@media(pointer:coarse)]:!h-11" aria-label="New chat" @click="emit('newChat')">
						<template #prefix>
							<Tooltip text="New chat" side="right"><span class="lucide-square-pen size-4 text-ink-gray-6" aria-hidden="true" /></Tooltip>
						</template>
					</SidebarItem>
				</div>
			</div>
		</div>
		<div class="px-2 pb-2">
			<SidebarItem class="!h-7 !transition-none [@media(pointer:coarse)]:!h-11" :aria-label="sidebarCollapsed ? 'Expand' : 'Collapse'" :aria-expanded="!sidebarCollapsed" @click="setSidebarCollapsed(!sidebarCollapsed)">
				<template #prefix>
					<Tooltip text="Expand" side="right" :disabled="!sidebarCollapsed">
						<span class="lucide-panel-right-open size-4 text-ink-gray-6" :class="{ 'rotate-180': sidebarCollapsed }" aria-hidden="true" />
					</Tooltip>
				</template>
				<span v-if="!sidebarCollapsed" class="truncate text-sm leading-tighter">Collapse</span>
			</SidebarItem>
		</div>
	</Sidebar>
	<div v-else class="flex flex-col gap-2 px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
		<SidebarHeader title="Ponder Chat" :subtitle="name" :logo="BrandLogo" :menu-items="menu" class="-mx-1 -mt-2" />
		<Button variant="outline" size="md" icon-left="lucide-square-pen" class="w-full !justify-start !px-2 bg-surface-base" @click="emit('newChat')">New chat</Button>
		<ThreadList :highlight="highlight" @select="emit('select', $event)">
			<WorkspaceRows :highlight="highlightWorkspace" @select="emit('selectWorkspace', $event)" @create="emit('newWorkspace')" />
		</ThreadList>
		<div v-if="me" class="border-t border-outline-gray-1 pt-2">
			<CreditMeter :credits="me.credits" />
		</div>
	</div>
</template>
