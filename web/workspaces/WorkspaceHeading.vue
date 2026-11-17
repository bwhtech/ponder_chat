<script setup lang="ts">
import { Button, Dropdown } from "frappe-ui";
import { computed, onBeforeUnmount, ref } from "vue";
import { canEdit, canShare, kindIcon, type WorkspaceSummary } from "./store";

/**
 * The workspace page's title row: its kind and name, and what the person may change. Whoever
 * shares it (the owner; admins on an organisation workspace) gets Share and a menu with Edit
 * and Delete; on a phone Share moves into the menu. Someone who can only edit gets Edit, drawn
 * as Share is.
 * Everything here comes from the sidebar's row, so it draws at once; the actions wait
 * (`ready`) for the workspace itself.
 */
const props = defineProps<{ workspace: WorkspaceSummary; ready: boolean }>();
const emit = defineEmits<{ edit: []; share: []; delete: [] }>();

// Tailwind's sm: the Share button shows from here.
const wideScreen = matchMedia("(min-width: 640px)");
const wide = ref(wideScreen.matches);
const onWidth = () => (wide.value = wideScreen.matches);
wideScreen.addEventListener("change", onWidth);
onBeforeUnmount(() => wideScreen.removeEventListener("change", onWidth));

const shares = computed(() => canShare(props.workspace));
const menu = computed(() => [
	...(wide.value ? [] : [{ label: "Share", icon: "lucide-share-2", onClick: () => emit("share") }]),
	{ label: "Edit", icon: "lucide-pencil", onClick: () => emit("edit") },
	{ label: "Delete", icon: "lucide-trash-2", theme: "red" as const, onClick: () => emit("delete") },
]);
</script>

<template>
	<span class="flex size-6 shrink-0 items-center justify-center rounded-4 bg-surface-gray-2 text-ink-gray-7" aria-hidden="true">
		<span :class="[kindIcon(workspace), 'size-3.5']" />
	</span>
	<h1 class="min-w-0 flex-1 truncate text-lg-semibold text-ink-gray-9">{{ workspace.name }}</h1>
	<div v-if="shares" class="flex shrink-0 items-center gap-1">
		<Button v-if="wide" icon-left="lucide-share-2" label="Share" :disabled="!ready" @click="emit('share')" />
		<Dropdown :options="menu" align="end">
			<Button variant="ghost" icon="lucide-ellipsis" aria-label="Workspace actions" class="touch-target" :disabled="!ready" />
		</Dropdown>
	</div>
	<Button v-else-if="canEdit(workspace)" icon-left="lucide-pencil" label="Edit" class="shrink-0" :disabled="!ready" @click="emit('edit')" />
</template>
