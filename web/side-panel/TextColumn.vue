<script setup lang="ts">
/**
 * The column that text reads in, in the side panel: a text file (TextView.vue), a document
 * (DocumentView.vue), and the panel's stand-in while either loads (PanelPlaceholder.vue).
 * One column for all three, so the stand-in's lines sit where the text will.
 */
</script>

<template>
	<article class="mx-auto w-full max-w-[680px] px-5 pb-16 pt-8 sm:px-10 sm:pt-10">
		<slot />
	</article>
</template>
