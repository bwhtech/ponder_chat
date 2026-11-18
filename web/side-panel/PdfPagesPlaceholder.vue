<script setup lang="ts">
import { Skeleton } from "frappe-ui";

/**
 * PdfPages.vue while its code (and pdf.js) loads: the same page-shaped skeleton that PdfPages
 * shows while the PDF itself loads, in the same place, so the panel is never blank.
 */
</script>

<template>
	<div data-slot="pdf-pages-placeholder" class="flex min-h-full flex-col items-center gap-3 p-3 pb-8 sm:p-6" aria-busy="true">
		<Skeleton class="aspect-[1/1.414] w-full max-w-[860px] rounded-2" />
	</div>
</template>
