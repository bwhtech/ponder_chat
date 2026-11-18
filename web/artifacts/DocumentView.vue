<script setup lang="ts">
import { Response } from "frappe-ui-ai-elements";
import type { Artifact } from "../side-panel/panel";
import TextColumn from "../side-panel/TextColumn.vue";

/** A Markdown document in the panel, drawn as replies are, in a column that reads like a page. */
defineProps<{ artifact: Artifact }>();
</script>

<template>
	<TextColumn>
		<Response :content="artifact.content" :parse-incomplete="artifact.writing" />
	</TextColumn>
</template>
