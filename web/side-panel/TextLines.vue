<script setup lang="ts">
import { Skeleton } from "frappe-ui";

/**
 * Lines of text while they load: in TextView's column while the file arrives, and in the
 * panel's stand-in (PanelPlaceholder.vue) while the panel's code arrives.
 */
const WIDTHS = ["w-2/5", "w-full", "w-11/12", "w-full", "w-3/5"];
</script>

<template>
	<div class="flex flex-col gap-2.5">
		<Skeleton v-for="width in WIDTHS" :key="width" :class="['h-3.5 rounded-4', width]" />
	</div>
</template>
