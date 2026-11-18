<script setup lang="ts">
import { Button } from "frappe-ui";
import { computed } from "vue";
import { accessIcon, workspaceById, type WorkspaceSummary } from "./store";

/**
 * The button of a new chat's workspace menu (WorkspacePicker.vue), beside the model menu and
 * drawn as its button is. It also stands in for that menu while its code loads, with the
 * menu's v-model, so the box does not move. A saved chat shows its workspace in the header's
 * breadcrumb instead.
 */
const props = defineProps<{ workspace?: WorkspaceSummary; modelValue?: string | null }>();
defineEmits<{ "update:modelValue": [id: string | null] }>();
const shown = computed(() => props.workspace ?? workspaceById(props.modelValue));
</script>

<template>
	<Button
		variant="ghost"
		size="sm"
		:icon-left="shown ? accessIcon(shown) : 'lucide-layers'"
		icon-right="lucide-chevron-down"
		:aria-label="`Workspace: ${shown?.name ?? 'none'}`"
		class="relative min-w-0 max-w-48 !text-ink-gray-6 after:absolute after:inset-0 after:content-[''] hover:!text-ink-gray-8 [@media(pointer:coarse)]:after:-inset-y-2"
	>
		<span class="truncate">{{ shown?.name ?? "Workspace" }}</span>
	</Button>
</template>
