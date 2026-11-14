<script setup lang="ts">
import { toRef } from "vue";
import CiteButton from "./CiteButton.vue";
import { useCiteSelection, type PendingCite } from "./selection";

/**
 * The Cite button for text selected in a reply (selection.ts). Part of the transcript's
 * chunk: a chat with no replies has nothing to quote. Cite hands the quote to the chat.
 */
const props = defineProps<{ area: HTMLElement | null }>();
const emit = defineEmits<{ cite: [shown: PendingCite] }>();
const { pending, dismiss } = useCiteSelection(toRef(props, "area"));

function cite() {
	const shown = pending.value;
	if (!shown || shown.tooLong) return;
	document.getSelection()?.removeAllRanges();
	dismiss();
	emit("cite", shown);
}
</script>

<template>
	<CiteButton v-if="pending" :pending="pending" @cite="cite" />
</template>
