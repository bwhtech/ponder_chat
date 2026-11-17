<script setup lang="ts">
import { Button, Dropdown } from "frappe-ui";
import { computed } from "vue";
import { documentIcon, fileSize, STATUS_LABELS, type WorkspaceDocument } from "./documents";

/**
 * One document in the side panel: its name and status. A person who can edit also sees its
 * size, why it failed with "Try again", and a menu with Details and Delete. Reading shows a
 * turning icon until the page's poll says Ready or Failed.
 */
const props = defineProps<{ document: WorkspaceDocument; editable: boolean; retrying: boolean }>();
const emit = defineEmits<{ details: []; retry: []; delete: [] }>();

const status = computed(() => props.document.status);
const menu = computed(() => [
	{ label: "Details", icon: "lucide-info", onClick: () => emit("details") },
	{ label: "Delete", icon: "lucide-trash-2", theme: "red" as const, onClick: () => emit("delete") },
]);
</script>

<template>
	<li class="flex gap-2.5 py-1" data-slot="workspace-document" :data-status="status" :aria-busy="status === 'reading' || undefined">
		<span
			:class="[
				status === 'reading' ? 'lucide-loader-circle animate-spin motion-reduce:animate-none' : documentIcon(document),
				status === 'failed' ? 'text-ink-red-6' : 'text-ink-gray-5',
				'mt-0.5 size-4 shrink-0',
			]"
			aria-hidden="true"
		/>
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm text-ink-gray-8" :title="document.name" data-slot="document-name">{{ document.name }}</p>
			<p class="text-p-sm text-ink-gray-6" data-slot="document-status">
				<span v-if="editable">{{ fileSize(document.size) }} · </span>
				<span :class="{ 'text-ink-red-6': status === 'failed' }">{{ STATUS_LABELS[status] }}</span>
			</p>
			<template v-if="editable && status === 'failed'">
				<p class="mt-1 break-words text-p-sm text-ink-red-6" data-slot="document-error">{{ document.error || "Something went wrong while reading it." }}</p>
				<Button size="sm" icon-left="lucide-rotate-ccw" label="Try again" class="mt-2" :loading="retrying" @click="emit('retry')" />
			</template>
		</div>
		<Dropdown v-if="editable" :options="menu" align="end">
			<Button variant="ghost" icon="lucide-ellipsis" :aria-label="`Actions for “${document.name}”`" class="touch-target -mr-1 shrink-0" />
		</Dropdown>
	</li>
</template>
