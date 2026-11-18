<script setup lang="ts">
import { BuiltinActionType, Renderer, type ActionEvent } from "@openuidev/vue-lang";
import { genuiVueLibrary } from "./components";
import { safeUrl, useCardSend } from "./actions";

/**
 * A card the model drew with show_ui (OpenUI Lang), drawn as it streams. Its own chunk,
 * with the OpenUI runtime and frappe-ui's charts and lists: a chat without cards never
 * loads it (ShowUiPart.vue). A button sends a message to Ponder or opens a page.
 */
const props = defineProps<{ code: string; streaming?: boolean }>();
const send = useCardSend();

function onAction(event: ActionEvent) {
	if (event.type === BuiltinActionType.OpenUrl) {
		const url = safeUrl(event.params?.url);
		if (url) window.open(url, "_blank", "noopener,noreferrer");
		return;
	}
	if (event.type === BuiltinActionType.ContinueConversation && event.humanFriendlyMessage.trim()) send?.(event.humanFriendlyMessage);
}
</script>

<template>
	<div data-slot="genui-card" class="min-w-0">
		<Renderer :response="props.code" :library="genuiVueLibrary" :is-streaming="!!props.streaming" :on-action="onAction" />
	</div>
</template>
