<script setup lang="ts">
/** A centred icon, title and line of text, with an optional action: the one recipe for empty and error states in the chat and /admin. */
defineProps<{ icon: string; title: string; body?: string; alert?: boolean }>();
</script>

<template>
	<div data-slot="empty-state" class="flex flex-col items-center justify-center px-3 py-16 text-center" :role="alert ? 'alert' : undefined">
		<div class="rounded-full bg-surface-gray-2 p-3 text-ink-gray-5">
			<span :class="[icon, 'block size-6']" aria-hidden="true" />
		</div>
		<p class="mt-4 text-base-medium text-ink-gray-8">{{ title }}</p>
		<p v-if="body" class="mt-1.5 max-w-sm text-balance text-p-sm text-ink-gray-6">{{ body }}</p>
		<div v-if="$slots.default" class="mt-5"><slot /></div>
	</div>
</template>
