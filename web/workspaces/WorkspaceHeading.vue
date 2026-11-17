<script setup lang="ts">
import { Badge, Button, Dropdown } from "frappe-ui";
import { computed } from "vue";
import { canEdit, canShare, kindIcon, sharedWith, type WorkspaceSummary } from "./store";

/**
 * The workspace page's title row: the name, who can use it, Share (for the owner, and for
 * admins on an organisation workspace) and a menu with what the person may change. Everything
 * here comes from the sidebar's row, so it draws at once; the actions wait (`ready`) for the
 * workspace itself.
 */
const props = defineProps<{ workspace: WorkspaceSummary; ready: boolean }>();
const emit = defineEmits<{ edit: []; share: []; delete: [] }>();

const menu = computed(() => [
	...(canEdit(props.workspace) ? [{ label: "Edit details", icon: "lucide-pencil", onClick: () => emit("edit") }] : []),
	...(canShare(props.workspace) ? [{ label: "Delete workspace", icon: "lucide-trash-2", theme: "red" as const, onClick: () => emit("delete") }] : []),
]);
</script>

<template>
	<span class="flex size-6 shrink-0 items-center justify-center rounded-4 bg-surface-gray-2 text-ink-gray-7" aria-hidden="true">
		<span :class="[kindIcon(workspace), 'size-3.5']" />
	</span>
	<h1 class="min-w-0 truncate text-lg-semibold text-ink-gray-9">{{ workspace.name }}</h1>
	<Badge variant="subtle" theme="gray" :label="sharedWith(workspace)" class="hidden shrink-0 sm:inline-flex" data-slot="workspace-shared-with">
		<template #prefix><span :class="[kindIcon(workspace), 'size-3']" aria-hidden="true" /></template>
	</Badge>
	<div class="ml-auto flex shrink-0 items-center gap-1">
		<Button v-if="canShare(workspace)" icon-left="lucide-share-2" label="Share" :disabled="!ready" @click="emit('share')" />
		<Dropdown v-if="menu.length" :options="menu" align="end">
			<Button variant="ghost" icon="lucide-ellipsis" aria-label="Workspace actions" class="touch-target" :disabled="!ready" />
		</Dropdown>
	</div>
</template>
