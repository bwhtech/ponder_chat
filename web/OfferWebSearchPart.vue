<script setup lang="ts">
import { computed } from "vue";
import { getToolName, Tool, ToolContent, ToolHeader, type ToolMessagePart } from "frappe-ui-ai-elements";

/**
 * An offer_web_search call (server/search/schema.ts): the workspace's Sources do not have the
 * answer, and web search is off. One line that says what is missing; the button that searches
 * the web is under the reply (ChatView.vue).
 */
const props = defineProps<{ part: ToolMessagePart; streaming?: boolean }>();
const missing = computed(() => String((props.part.input as { missing?: string } | undefined)?.missing ?? "").trim());
</script>

<template>
	<Tool>
		<ToolHeader :state="part.state" :tool-name="getToolName(part)" :title="missing ? `Not in Sources · ${missing}` : 'Not in Sources'" icon="lucide-file-search" :streaming="streaming" />
		<ToolContent>
			<p class="text-p-sm text-ink-gray-6">Web search is off in this chat, so this reply uses only the workspace's Sources.</p>
		</ToolContent>
	</Tool>
</template>
