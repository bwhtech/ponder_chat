<script setup lang="ts">
import type { DropdownOptions } from "frappe-ui";
import { h, ref } from "vue";
import { useLazyMenu } from "./lazy-menu";

/**
 * The account menu at the top of the chats: frappe-ui's SidebarHeader, drawn the same way,
 * but its Dropdown loads only once the header is pointed at, touched or focused
 * (lazy-menu.ts). SidebarHeader brought reka-ui's menus to the first page.
 */
const props = defineProps<{ title: string; subtitle: string; logo: string; menuItems: DropdownOptions }>();
const armed = ref(false);
const arm = () => (armed.value = true);
const { Dropdown, shown, open, plain, trigger } = useLazyMenu(() => armed.value);

/** A press before the header was armed: arm it, and open once the menu is there. */
function openNow() {
	armed.value = true;
	open.value = true;
}

/** The logo, the title and the person, then the chevron: SidebarHeader's markup. */
const Identity = () => [
	h("div", { class: "size-7 shrink-0 overflow-hidden rounded-[6px]" }, h("img", { src: props.logo, class: "h-full w-full object-cover", alt: "Logo" })),
	h("div", { class: "ml-2 flex w-auto flex-1 flex-col truncate text-left opacity-100" }, [
		h("div", { class: "truncate text-base-medium leading-tighter text-ink-gray-8" }, props.title),
		h("div", { class: "mt-0.5 truncate text-sm leading-tighter text-ink-gray-6" }, props.subtitle),
	]),
	h("div", { class: "ml-2 w-auto opacity-100" }, h("span", { class: "lucide-chevron-down size-4 text-ink-gray-7" })),
];
</script>

<template>
	<div data-slot="sidebar-header" class="flex h-12 shrink-0 items-center px-1" @pointerenter="arm" @focusin="arm" @touchstart.passive="arm">
		<component :is="Dropdown" v-if="shown" v-model:open="open" :options="menuItems" match-trigger-width>
			<template #default="{ open: isOpen }">
				<button ref="trigger" type="button" class="flex h-10 w-full items-center rounded-4 px-1.5" :class="isOpen ? 'bg-surface-elevation-2 shadow-sm' : 'hover:bg-surface-gray-3'">
					<Identity />
				</button>
			</template>
		</component>
		<button v-else ref="plain" type="button" class="flex h-10 w-full items-center rounded-4 px-1.5 hover:bg-surface-gray-3" aria-haspopup="menu" @click="openNow">
			<Identity />
		</button>
	</div>
</template>
