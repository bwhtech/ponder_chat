<script setup lang="ts">
/**
 * An empty section of the workspace's side panel, for people who can edit: one dashed row,
 * the whole of it a button that fills the section ("Add instructions", "Upload files").
 * `busy` turns its icon while that is under way.
 */
defineProps<{ icon: string; label: string; busy?: boolean }>();
</script>

<template>
	<button
		type="button"
		class="flex min-h-11 w-full items-center gap-2 rounded-4 border border-dashed border-outline-gray-2 px-3 text-left text-base text-ink-gray-6 transition-colors duration-150 ease-out-strong hover:bg-surface-gray-1 active:bg-surface-gray-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-outline-gray-3 disabled:cursor-default disabled:hover:bg-transparent motion-reduce:transition-none"
		:disabled="busy"
		:aria-busy="busy || undefined"
	>
		<span :class="[busy ? 'lucide-loader-circle animate-spin motion-reduce:animate-none' : icon, 'size-4 shrink-0']" aria-hidden="true" />
		{{ label }}
	</button>
</template>
