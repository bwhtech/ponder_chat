<script setup lang="ts">
import { Button } from "frappe-ui";
import { computed } from "vue";
import { followWorkspaceLink, kindIcon, workspaceById, workspaceHref, type WorkspaceSummary } from "./store";

/**
 * The composer's workspace, beside the model menu. `locked`: a chat's workspace, which never
 * changes, as quiet text that links to the workspace's page. Otherwise the button of the
 * workspace menu (WorkspacePicker.vue), drawn as the model menu's button is. It also stands
 * in for that menu while its code loads, with the menu's v-model, so the box does not move.
 */
const props = defineProps<{ workspace?: WorkspaceSummary; modelValue?: string | null; locked?: boolean }>();
defineEmits<{ "update:modelValue": [id: string | null] }>();
const shown = computed(() => props.workspace ?? workspaceById(props.modelValue));
</script>

<template>
	<a
		v-if="locked && shown"
		data-slot="workspace-chip"
		:href="workspaceHref(shown.slug)"
		class="relative flex h-7 min-w-0 max-w-48 items-center gap-1.5 rounded-4 px-2 text-sm text-ink-gray-6 transition-colors duration-150 ease-out-strong after:absolute after:inset-0 after:content-[''] hover:bg-surface-gray-2 hover:text-ink-gray-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-outline-gray-3 motion-reduce:transition-none [@media(pointer:coarse)]:after:-inset-y-2"
		:title="`Open “${shown.name}”`"
		@click="followWorkspaceLink($event, shown.slug)"
	>
		<span :class="[kindIcon(shown), 'size-4 shrink-0']" aria-hidden="true" />
		<span class="truncate">{{ shown.name }}</span>
	</a>
	<Button
		v-else
		variant="ghost"
		size="sm"
		:icon-left="shown ? kindIcon(shown) : 'lucide-layers'"
		icon-right="lucide-chevron-down"
		:aria-label="`Workspace: ${shown?.name ?? 'none'}`"
		class="relative min-w-0 max-w-48 !text-ink-gray-6 after:absolute after:inset-0 after:content-[''] hover:!text-ink-gray-8 [@media(pointer:coarse)]:after:-inset-y-2"
	>
		<span class="truncate">{{ shown?.name ?? "Workspace" }}</span>
	</Button>
</template>
