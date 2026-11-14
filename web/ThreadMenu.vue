<script setup lang="ts">
import type { DropdownOptions } from "frappe-ui";
import { useLazyMenu } from "./lazy-menu";

/**
 * A chat's ⋯ menu in the list. Each menu is a tree of reka-ui components, about 10 ms of a
 * phone's time, and the list holds up to 200 chats. So a row shows only its button, and the
 * menu loads and mounts once the row is pointed at, touched or focused: ThreadList adds the
 * chat to `armed`, before the press that opens it (lazy-menu.ts). Each menu reads `armed`
 * itself, so arming one row renders that row alone.
 */
const props = defineProps<{ id: string; title: string; options: DropdownOptions; current: boolean; armed: Set<string> }>();
const { Dropdown, shown, open, plain, trigger } = useLazyMenu(() => props.armed.has(props.id));

const BUTTON =
	"relative flex size-6 items-center justify-center rounded-4 text-ink-gray-5 opacity-0 transition-opacity duration-150 ease-out-strong after:absolute after:-inset-1 after:content-[''] [@media(pointer:coarse)]:after:-inset-2.5 hover:bg-surface-gray-3 hover:text-ink-gray-8 focus-visible:opacity-100 active:bg-surface-gray-4 aria-expanded:opacity-100 data-[state=open]:opacity-100 group-hover/sidebar-item:opacity-100 group-focus-within/sidebar-item:opacity-100 motion-reduce:transition-none [@media(pointer:coarse)]:opacity-100";

/** A press before the row was armed (no hover or focus came first): arm it, and open once the menu is there. */
function openNow() {
	props.armed.add(props.id);
	open.value = true;
}
</script>

<template>
	<component :is="Dropdown" v-if="shown" v-model:open="open" :options="options" align="end">
		<template #trigger>
			<button ref="trigger" type="button" :class="[BUTTON, { 'opacity-100': current }]" :aria-label="`Actions for ${title}`">
				<span class="lucide-ellipsis size-4" aria-hidden="true" />
			</button>
		</template>
	</component>
	<button v-else ref="plain" type="button" :class="[BUTTON, { 'opacity-100': current }]" :aria-label="`Actions for ${title}`" aria-haspopup="menu" @click="openNow">
		<span class="lucide-ellipsis size-4" aria-hidden="true" />
	</button>
</template>
