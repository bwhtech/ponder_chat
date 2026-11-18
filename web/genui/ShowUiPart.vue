<script setup lang="ts">
import { computed, defineAsyncComponent } from "vue";
import { getToolPhase, Tool, ToolContent, ToolHeader, ToolOutput, type ToolMessagePart } from "frappe-ui-ai-elements";
import CardPlaceholder from "./CardPlaceholder.vue";

/**
 * A show_ui call (server/genui/tool.ts): the card, drawn while the model writes it. The
 * card's code (the OpenUI runtime, frappe-ui's charts and lists) is its own chunk, so a
 * chat without cards never loads it; until it is here, a quiet box holds the place.
 *
 * If the server found problems, the model draws the card again, so the failed try is one
 * line, with what was wrong folded under it, and not a broken card.
 */
const GenuiCard = defineAsyncComponent({ loader: () => import("./GenuiCard.vue"), loadingComponent: CardPlaceholder, delay: 0 });

const props = defineProps<{ part: ToolMessagePart; streaming?: boolean }>();
const input = computed(() => (props.part.input ?? {}) as { title?: string; code?: string });
const phase = computed(() => getToolPhase(props.part.state, { streaming: props.streaming }));
const writing = computed(() => phase.value === "preparing" || phase.value === "running");
const subject = computed(() => (input.value.title?.trim() ? `“${input.value.title.trim()}”` : "a card"));
</script>

<template>
	<Tool v-if="part.state === 'output-error'">
		<ToolHeader :state="part.state" tool-name="show_ui" :title="`Could not draw ${subject}`" icon="lucide-layout-dashboard" :streaming="streaming" />
		<ToolContent>
			<ToolOutput :output="undefined" :error-text="part.errorText" />
		</ToolContent>
	</Tool>
	<div v-else-if="input.code?.trim()" data-slot="genui-part" class="my-1.5">
		<GenuiCard :code="input.code" :streaming="writing" />
	</div>
	<Tool v-else>
		<ToolHeader :state="part.state" tool-name="show_ui" :title="writing ? `Drawing ${subject}` : `Did not draw ${subject}`" icon="lucide-layout-dashboard" :streaming="streaming" />
	</Tool>
</template>
