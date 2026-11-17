<script setup lang="ts">
import { Skeleton } from "frappe-ui";

/**
 * A CSV or TSV table while it loads: TableView shows it while the file arrives, and the
 * panel's stand-in (PanelPlaceholder.vue) shows it while the panel's code arrives, so the
 * rows stay in one place.
 */
</script>

<template>
	<div class="flex flex-col gap-2 p-4" aria-busy="true">
		<Skeleton v-for="line in 8" :key="line" class="h-6 w-full rounded-2" />
	</div>
</template>
