<script setup lang="ts">
import { computed } from "vue";
import { Source } from "./ai-elements/sources";
import { getToolName, Tool, ToolContent, ToolHeader, ToolOutput, type ToolMessagePart } from "./ai-elements/tool";

/**
 * A web_search or web_fetch call (server/search/tool.ts) as one Tool line: what was
 * searched or read, and the pages it found, folded below.
 */
type Output = { results?: { title: string; url: string }[]; url?: string; title?: string; error?: string };

const props = defineProps<{ part: ToolMessagePart; streaming?: boolean }>();
const search = computed(() => getToolName(props.part) === "web_search");
const input = computed(() => (props.part.input ?? {}) as { query?: string; url?: string });
const output = computed(() => (props.part.state === "output-available" ? (props.part.output as Output) : undefined));
const running = computed(() => props.part.state === "input-streaming" || props.part.state === "input-available");

const subject = computed(() => (search.value ? `“${input.value.query ?? ""}”` : hostname(output.value?.url ?? input.value.url ?? "")));
const title = computed(() => {
	if (running.value) return props.streaming ? `${search.value ? "Searching" : "Reading"} ${subject.value}` : `Did not finish ${subject.value}`;
	if (output.value?.error || props.part.state === "output-error") return `Could not ${search.value ? "search" : "read"} ${subject.value}`;
	return `${search.value ? "Searched" : "Read"} ${subject.value}`;
});
const pages = computed(() => {
	if (!output.value) return [];
	if (search.value) return output.value.results ?? [];
	return output.value.url && !output.value.error ? [{ url: output.value.url, title: output.value.title }] : [];
});

function hostname(url: string) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}
</script>

<template>
	<Tool>
		<ToolHeader :state="part.state" :tool-name="getToolName(part)" :title="title" :icon="search ? 'lucide-search' : 'lucide-globe'" :streaming="streaming" />
		<ToolContent>
			<Source v-for="page in pages" :key="page.url" :href="page.url" :title="page.title" />
			<p v-if="output?.error" class="text-p-sm text-ink-gray-6">{{ output.error }}</p>
			<ToolOutput v-if="part.state === 'output-error'" :output="undefined" :error-text="part.errorText" />
		</ToolContent>
	</Tool>
</template>
