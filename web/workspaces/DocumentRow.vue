<script setup lang="ts">
import { Button, Dropdown } from "frappe-ui";
import { computed } from "vue";
import { documentIcon, failureReason, fileSize, STATUS_LABELS, type WorkspaceDocument } from "./documents";

/**
 * One document in the side panel: its name, and its status while it is not Ready ("66 KB",
 * "66 KB · Reading…", "2.3 MB · Could not read page 3"). A person who can edit also sees its
 * size, "Try again" when it failed, and a menu with Details and Delete. Reading shows a turning
 * icon until the page's poll says Ready or Failed. The name opens the file, whatever its status.
 */
const props = defineProps<{ document: WorkspaceDocument; editable: boolean; retrying: boolean }>();
const emit = defineEmits<{ open: []; details: []; retry: []; delete: [] }>();

const status = computed(() => props.document.status);
const size = computed(() => (props.editable ? fileSize(props.document.size) : ""));
const statusText = computed(() => (status.value === "failed" ? failureReason(props.document.error) : STATUS_LABELS[status.value]));
const menu = computed(() => [
	{ label: "Details", icon: "lucide-info", onClick: () => emit("details") },
	{ label: "Delete", icon: "lucide-trash-2", theme: "red" as const, onClick: () => emit("delete") },
]);
</script>

<template>
	<li
		class="relative flex gap-2.5 rounded-4 px-2 py-1 transition-colors duration-150 ease-out-strong has-[[data-slot=document-name]:hover]:bg-surface-gray-2 has-[[data-slot=document-name]:active]:bg-surface-gray-3 motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center"
		data-slot="workspace-document"
		:data-status="status"
		:aria-busy="status === 'reading' || undefined"
	>
		<span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
			<span
				:class="[
					status === 'reading' ? 'lucide-loader-circle animate-spin motion-reduce:animate-none' : documentIcon(document),
					status === 'failed' ? 'text-ink-red-6' : 'text-ink-gray-5',
					'size-4',
				]"
			/>
		</span>
		<div class="min-w-0 flex-1">
			<!-- The name opens the file; its area covers the row, under Try again and the menu. -->
			<button
				type="button"
				class="block w-full truncate text-left text-sm text-ink-gray-8 after:absolute after:inset-0 after:rounded-4 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-outline-gray-3"
				:title="document.name"
				data-slot="document-name"
				@click="emit('open')"
			>{{ document.name }}</button>
			<p v-if="size || status !== 'ready'" class="text-p-sm text-ink-gray-6" data-slot="document-status">
				{{ size && status !== "ready" ? `${size} · ` : size }}<span v-if="status !== 'ready'" :class="{ 'text-ink-red-6': status === 'failed' }">{{ statusText }}</span>
			</p>
			<Button
				v-if="editable && status === 'failed'"
				variant="ghost"
				size="sm"
				icon-left="lucide-rotate-ccw"
				label="Try again"
				class="touch-target relative -ml-2 mt-0.5 !text-sm"
				:loading="retrying"
				@click="emit('retry')"
			/>
		</div>
		<Dropdown v-if="editable" :options="menu" align="end">
			<Button variant="ghost" icon="lucide-ellipsis" :aria-label="`Actions for “${document.name}”`" class="touch-target relative -mr-1 shrink-0" />
		</Dropdown>
	</li>
</template>
