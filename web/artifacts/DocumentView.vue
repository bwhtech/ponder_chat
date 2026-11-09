<script setup lang="ts">
import Response from "../ai-elements/response/Response.vue";
import type { Artifact } from "../side-panel/panel";

/** A Markdown document in the panel, drawn as replies are, in a column that reads like a page. */
defineProps<{ artifact: Artifact }>();
</script>

<template>
	<article class="mx-auto w-full max-w-[680px] px-5 pb-16 pt-8 sm:px-10 sm:pt-10">
		<Response :content="artifact.content" :parse-incomplete="artifact.writing" />
	</article>
</template>
