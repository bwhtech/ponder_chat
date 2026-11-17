<script setup lang="ts">
import { Button, Dropdown } from "frappe-ui";
import { computed } from "vue";
import { documentIcon, failureReason, fileSize, STATUS_LABELS, type WorkspaceDocument } from "./documents";

/**
 * One document in the side panel: its name, and its status while it is not Ready ("66 KB",
 * "66 KB · Reading…", "2.3 MB · Could not read page 3"). A person who can edit also sees its
 * size, "Try again" when it failed, and a menu with Details and Delete. Reading shows a turning
 * icon until the page's poll says Ready or Failed.
 */
const props = defineProps<{ document: WorkspaceDocument; editable: boolean; retrying: boolean }>();
const emit = defineEmits<{ details: []; retry: []; delete: [] }>();

const status = computed(() => props.document.status);
const size = computed(() => (props.editable ? fileSize(props.document.size) : ""));
const statusText = computed(() => (status.value === "failed" ? failureReason(props.document.error) : STATUS_LABELS[status.value]));
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
			<p v-if="size || status !== 'ready'" class="text-p-sm text-ink-gray-6" data-slot="document-status">
				{{ size && status !== "ready" ? `${size} · ` : size }}<span v-if="status !== 'ready'" :class="{ 'text-ink-red-6': status === 'failed' }">{{ statusText }}</span>
			</p>
			<Button
				v-if="editable && status === 'failed'"
				variant="ghost"
				size="sm"
				icon-left="lucide-rotate-ccw"
				label="Try again"
				class="touch-target -ml-2 mt-0.5 !text-sm"
				:loading="retrying"
				@click="emit('retry')"
			/>
		</div>
		<Dropdown v-if="editable" :options="menu" align="end">
			<Button variant="ghost" icon="lucide-ellipsis" :aria-label="`Actions for “${document.name}”`" class="touch-target -mr-1 shrink-0" />
		</Dropdown>
	</li>
</template>
