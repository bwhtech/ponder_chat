<script setup lang="ts">
/** A footnote with a lock: what admins can and cannot see. */
</script>

<template>
	<p class="flex items-center gap-1.5 text-sm text-ink-gray-5">
		<span class="lucide-lock size-3.5 shrink-0" aria-hidden="true" />
		<slot />
	</p>
</template>
