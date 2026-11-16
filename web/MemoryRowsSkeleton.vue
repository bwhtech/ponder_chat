<script setup lang="ts">
import { Skeleton } from "frappe-ui";

/** Rows shaped like memories while they load: a line of text, then its kind and age (MemoryView.vue, MemoryPlaceholder.vue). */
</script>

<template>
	<ul class="divide-y divide-outline-gray-1 rounded-6 border border-outline-gray-2" aria-busy="true" aria-label="Loading memories">
		<li v-for="width in ['w-4/5', 'w-3/5', 'w-2/3']" :key="width" class="space-y-2 px-3 py-3">
			<Skeleton :class="['h-4 rounded-4', width]" />
			<div class="flex items-center gap-2">
				<Skeleton class="h-4 w-14 rounded-full" />
				<Skeleton class="h-3 w-16 rounded-4" />
			</div>
		</li>
	</ul>
</template>
