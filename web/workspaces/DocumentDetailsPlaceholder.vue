<script setup lang="ts">
import { Skeleton } from "frappe-ui";

/**
 * A document's Details (DocumentDetails.vue) while their code arrives: skeletons in the places
 * of the summary's lines and buttons (DocumentSummary.vue), with the same padding. Only plain
 * markup: this loads with the page (stand-ins.ts), so it must not bring the summary's code.
 */
</script>

<template>
	<div class="space-y-6 px-4 pb-10 pt-5 sm:px-5" aria-busy="true" aria-label="Loading the details">
		<div class="space-y-4">
			<div class="flex h-[1lh] items-center text-p-sm"><Skeleton class="h-2.5 w-40 rounded-4" /></div>
			<div class="flex h-[1lh] items-center text-base"><Skeleton class="h-3 w-48 rounded-4" /></div>
			<div class="flex h-[1lh] items-center text-p-sm"><Skeleton class="h-2.5 w-56 max-w-full rounded-4" /></div>
			<Skeleton class="h-7 w-24 rounded-4" />
		</div>
	</div>
</template>
