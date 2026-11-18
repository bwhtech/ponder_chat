<script setup lang="ts">
import { Shimmer } from "frappe-ui-ai-elements";
import { computed } from "vue";
import { cardSubject } from "./labels";

/**
 * A card's place while its code loads (ShowUiPart.vue's loading component, so it gets the
 * card's props): a box of about a chart's height that says what is coming. "Drawing" while
 * the reply writes the card, "Loading" for a card in a chat opened again.
 */
const props = defineProps<{ title?: string; streaming?: boolean }>();
const text = computed(() => `${props.streaming ? "Drawing" : "Loading"} ${cardSubject(props.title)}`);
</script>

<template>
	<div data-slot="genui-placeholder" class="flex h-72 items-center justify-center rounded-4 border border-outline-gray-1 bg-surface-gray-1 px-4" role="status">
		<Shimmer class="truncate text-p-sm text-ink-gray-6">{{ text }}</Shimmer>
	</div>
</template>
