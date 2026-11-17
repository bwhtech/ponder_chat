<script setup lang="ts">
import { Button } from "frappe-ui";
import { computed } from "vue";
import { kindIcon, workspaceById, type WorkspaceSummary } from "./store";

/**
 * The composer's workspace, beside the model menu. `locked`: a chat's workspace, which never
 * changes, as plain text. Otherwise the button of the workspace menu (WorkspacePicker.vue).
 * It also stands in for that menu while its code loads, with the menu's v-model, so the
 * message box does not move.
 */
const props = defineProps<{ workspace?: WorkspaceSummary; modelValue?: string | null; locked?: boolean }>();
defineEmits<{ "update:modelValue": [id: string | null] }>();
const shown = computed(() => props.workspace ?? workspaceById(props.modelValue));
</script>

<template>
	<span
		v-if="locked && shown"
		data-slot="workspace-chip"
		class="flex h-7 min-w-0 max-w-48 items-center gap-1.5 rounded-4 bg-surface-gray-2 px-2 text-sm text-ink-gray-8"
		:title="`This chat is in “${shown.name}”`"
	>
		<span :class="[kindIcon(shown), 'size-3.5 shrink-0 text-ink-gray-6']" aria-hidden="true" />
		<span class="truncate">{{ shown.name }}</span>
	</span>
	<Button
		v-else
		:variant="shown ? 'subtle' : 'ghost'"
		size="sm"
		:icon-left="shown ? kindIcon(shown) : 'lucide-layers'"
		icon-right="lucide-chevron-down"
		:aria-label="`Workspace: ${shown?.name ?? 'none'}`"
		class="relative min-w-0 max-w-48 after:absolute after:inset-0 after:content-[''] [@media(pointer:coarse)]:after:-inset-y-2"
		:class="shown ? '' : '!text-ink-gray-6 hover:!text-ink-gray-8'"
	>
		<span class="truncate">{{ shown?.name ?? "Workspace" }}</span>
	</Button>
</template>
