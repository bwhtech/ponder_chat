<script setup lang="ts">
import { Button, Sidebar, SidebarHeader, SidebarItem, Tooltip, type DropdownOptions } from "frappe-ui";
import { computed, ref } from "vue";
import { me } from "./account";
import BrandLogo from "./BrandLogo.vue";
import CreditMeter from "./CreditMeter.vue";
import { setSidebarCollapsed, sidebarCollapsed, useSidebarPeek } from "./sidebar";
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
const panel = ref<HTMLElement | null>(null);
const { peeking, enterIcon, leaveIcon, enterPanel, leavePanel } = useSidebarPeek(panel);
const folded = computed(() => sidebarCollapsed.value && !peeking.value);
</script>

<template>
	<!-- Holds the sidebar's place in the page, so a preview slides over the chat without moving it. -->
	<div
		v-if="!sheet"
		ref="panel"
		class="relative hidden h-full shrink-0 transition-[width] duration-200 ease-out-strong motion-reduce:transition-none md:block"
		:class="sidebarCollapsed ? 'w-12' : 'w-64'"
		@pointerenter="enterPanel"
		@pointerleave="leavePanel"
	>
		<Sidebar
			:collapsible="false"
			class="absolute inset-y-0 left-0 z-[25] border-r border-outline-gray-1 !transition-[width,box-shadow] !duration-200 !ease-out-strong motion-reduce:!transition-none"
			:class="{ 'shadow-xl': peeking }"
			:width="folded ? '3rem' : '16rem'"
			aria-label="Chats"
		>
			<div class="relative min-h-0 flex-1 overflow-clip">
				<!-- Stays laid out at full width while folded: the list keeps its scroll and search, and its text never rewraps as the width moves.
				     Only the width and this fade animate: frappe-ui's own collapse runs a transition on every row, which outlasts the width and flickers. -->
				<div class="absolute inset-y-0 left-0 flex w-[calc(16rem-1px)] flex-col transition-opacity duration-200 ease-out-strong motion-reduce:transition-none" :class="{ 'opacity-0': folded }" :inert="folded">
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
				<!-- Stays over the header's logo during a preview, so the click that keeps the sidebar open lands where the pointer already is. -->
				<button
					v-if="sidebarCollapsed"
					type="button"
					aria-label="Expand"
					aria-expanded="false"
					class="absolute left-1.5 top-1.5 z-10 flex size-9 items-center justify-center rounded-4 bg-surface-sidebar text-ink-gray-6 after:absolute after:-inset-1 after:content-[''] hover:bg-surface-gray-3 focus-visible:ring-0 focus-visible:focus-ring"
					@pointerenter="enterIcon"
					@pointerleave="leaveIcon"
					@click="setSidebarCollapsed(false)"
				>
					<span class="lucide-panel-left size-4" aria-hidden="true" />
				</button>
			</div>
			<div class="relative px-2 pb-2">
				<div class="w-[calc(15rem-1px)] transition-opacity duration-200 ease-out-strong motion-reduce:transition-none" :class="{ 'opacity-0': folded }" :inert="folded">
					<SidebarItem class="!h-7 !transition-none [@media(pointer:coarse)]:!h-11" :aria-label="sidebarCollapsed ? 'Keep open' : 'Collapse'" :aria-expanded="!sidebarCollapsed" @click="setSidebarCollapsed(!sidebarCollapsed)">
						<template #prefix>
							<span class="lucide-panel-right-open size-4 text-ink-gray-6" :class="{ 'rotate-180': sidebarCollapsed }" aria-hidden="true" />
						</template>
						<span class="truncate text-sm leading-tighter">{{ sidebarCollapsed ? "Keep open" : "Collapse" }}</span>
					</SidebarItem>
				</div>
				<Transition enter-active-class="transition-opacity duration-200 ease-out-strong motion-reduce:transition-none" leave-active-class="transition-opacity duration-200 ease-out-strong motion-reduce:transition-none" enter-from-class="opacity-0" leave-to-class="opacity-0">
					<div v-if="folded" class="absolute left-2 top-0 w-[calc(2rem-1px)]">
						<SidebarItem class="!h-7 !transition-none [@media(pointer:coarse)]:!h-11" aria-label="New chat" @click="emit('newChat')">
							<template #prefix>
								<Tooltip text="New chat" side="right"><span class="lucide-square-pen size-4 text-ink-gray-6" aria-hidden="true" /></Tooltip>
							</template>
						</SidebarItem>
					</div>
				</Transition>
			</div>
		</Sidebar>
	</div>
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
