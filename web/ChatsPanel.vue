<script setup lang="ts">
import { Button, Sidebar, SidebarHeader, type DropdownOptions } from "frappe-ui";
import { me } from "./account";
import BrandLogo from "./BrandLogo.vue";
import CreditMeter from "./CreditMeter.vue";
import ThreadList from "./ThreadList.vue";

/**
 * The chats: the account menu, the list, New chat and the credits. A sidebar on a wide
 * screen, or the content of the bottom sheet on a phone (`sheet`). Its own chunk: a phone
 * draws it only when the sheet opens, and a wide screen fetches it beside the page's first
 * code (server/boot-page.ts), so it does not wait for it (Workspace.vue).
 */
defineProps<{ sheet?: boolean; name: string; menu: DropdownOptions; highlight: boolean }>();
const emit = defineEmits<{ select: [id: string]; newChat: [] }>();
</script>

<template>
	<Sidebar v-if="!sheet" class="hidden border-r border-outline-gray-1 md:flex" width="16rem" :collapsible="false" aria-label="Chats">
		<SidebarHeader title="Ponder Chat" :subtitle="name" :logo="BrandLogo" :menu-items="menu" />
		<div class="flex min-h-0 flex-1 flex-col px-2">
			<ThreadList scroll :highlight="highlight" @select="emit('select', $event)" />
		</div>
		<!-- The main action, under the list: always in the same place, however long the list grows.
		     Its content starts on the sidebar's edges, like the search field: icon at 16px, label at 40px. -->
		<div class="px-2 pb-3 pt-3">
			<Button variant="outline" size="md" icon-left="lucide-square-pen" class="w-full !justify-start !px-2 bg-surface-base transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out-strong active:scale-[0.98] motion-reduce:transform-none" @click="emit('newChat')">New chat</Button>
		</div>
		<div v-if="me" class="px-2 pb-2">
			<CreditMeter :credits="me.credits" />
		</div>
	</Sidebar>
	<div v-else class="flex flex-col gap-2 px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
		<SidebarHeader title="Ponder Chat" :subtitle="name" :logo="BrandLogo" :menu-items="menu" class="-mx-1 -mt-2" />
		<Button variant="outline" size="md" icon-left="lucide-square-pen" class="w-full !justify-start !px-2 bg-surface-base" @click="emit('newChat')">New chat</Button>
		<ThreadList :highlight="highlight" @select="emit('select', $event)" />
		<div v-if="me" class="border-t border-outline-gray-1 pt-2">
			<CreditMeter :credits="me.credits" />
		</div>
	</div>
</template>
