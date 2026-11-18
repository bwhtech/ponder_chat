<script setup lang="ts">
import { computed, defineAsyncComponent } from "vue";
import { getToolPhase, Tool, ToolContent, ToolHeader, ToolOutput, type ToolMessagePart } from "frappe-ui-ai-elements";
import CardPlaceholder from "./CardPlaceholder.vue";
import { cardSubject } from "./labels";

/**
 * A show_ui call (server/genui/tool.ts): the card, drawn while the model writes it. The
 * card's code (the OpenUI runtime, frappe-ui's charts and lists) is its own chunk, so a
 * chat without cards never loads it; until it is here, a box holds the place and says what
 * is coming.
 *
 * If the server found problems, the model draws the card again, so the failed try is one
 * line, with what was wrong folded under it, and not a broken card.
 */
const GenuiCard = defineAsyncComponent({ loader: () => import("./GenuiCard.vue"), loadingComponent: CardPlaceholder, delay: 0 });

const props = defineProps<{ part: ToolMessagePart; streaming?: boolean }>();
const input = computed(() => (props.part.input ?? {}) as { title?: string; code?: string });
const phase = computed(() => getToolPhase(props.part.state, { streaming: props.streaming }));
const writing = computed(() => phase.value === "preparing" || phase.value === "running");
const subject = computed(() => cardSubject(input.value.title));
// While it streams, the card shows once its first statement is whole (root = Stack([...])): before that it would draw nothing, and the line says what is coming.
const drawable = computed(() => Boolean(input.value.code?.trim()) && (!writing.value || input.value.code!.includes("\n")));
</script>

<template>
	<Tool v-if="part.state === 'output-error'">
		<ToolHeader :state="part.state" tool-name="show_ui" :title="`Could not draw ${subject}`" icon="lucide-layout-dashboard" :streaming="streaming" />
		<ToolContent>
			<ToolOutput :output="undefined" :error-text="part.errorText" />
		</ToolContent>
	</Tool>
	<div v-else-if="drawable" data-slot="genui-part" class="my-1.5">
		<GenuiCard :code="input.code!" :title="input.title" :streaming="writing" />
	</div>
	<Tool v-else>
		<ToolHeader :state="part.state" tool-name="show_ui" :title="writing ? `Drawing ${subject}` : `Did not draw ${subject}`" icon="lucide-layout-dashboard" :streaming="streaming" />
	</Tool>
</template>
