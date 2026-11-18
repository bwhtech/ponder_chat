<script setup lang="ts">
import { computed } from "vue";
import { panelItem } from "../side-panel/panel";
import DocumentSummary from "./DocumentSummary.vue";

/**
 * A document's Details (DocumentDetails.vue) while their code arrives: the summary as far as
 * the row knows it, its buttons off, and skeletons where the log's numbers go. The same
 * padding as Details, so nothing moves when they take its place.
 */
const document = computed(() => (panelItem.value?.type === "details" ? panelItem.value.details.document : null));
</script>

<template>
	<div v-if="document" class="space-y-6 px-4 pb-10 pt-5 sm:px-5" aria-busy="true">
		<DocumentSummary :document="document" :log="null" stand-in />
	</div>
</template>
