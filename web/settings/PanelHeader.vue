<script setup lang="ts">
/**
 * frappe-ui's SettingsHeader, with 1rem side padding on phones. SettingsHeader and
 * SettingsBody pad 4.4rem on every screen, which leaves a phone about 210px.
 */
defineProps<{ title?: string; description?: string }>();
</script>

<template>
	<div class="shrink-0 pl-4 pr-14 pt-6 sm:pl-12 sm:pr-16 sm:pt-[2.375rem]">
		<slot>
			<div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
				<div class="flex min-w-0 flex-col gap-1">
					<h2 v-if="title" class="text-2xl-semibold text-ink-gray-9">{{ title }}</h2>
					<p v-if="description" class="text-base text-ink-gray-6">{{ description }}</p>
				</div>
				<div v-if="$slots.actions" class="flex shrink-0 items-center gap-2">
					<slot name="actions" />
				</div>
			</div>
		</slot>
	</div>
</template>
