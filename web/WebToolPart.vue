<script setup lang="ts">
import { computed } from "vue";
import { getToolName, getToolPhase, Source, Tool, ToolContent, ToolHeader, ToolOutput, type ToolMessagePart } from "frappe-ui-ai-elements";

/**
 * A web_search or web_fetch call (server/search/tool.ts) as one Tool line: what was
 * searched or read, and the pages it found, folded below. A deep search (deep research) says so
 * once it has answered: its input is the same as a quick search's.
 */
type Output = { results?: { title: string; url: string }[]; url?: string; title?: string; error?: string; deep?: boolean };

const props = defineProps<{ part: ToolMessagePart; streaming?: boolean }>();
const search = computed(() => getToolName(props.part) === "web_search");
const input = computed(() => (props.part.input ?? {}) as { query?: string; url?: string });
const output = computed(() => (props.part.state === "output-available" ? (props.part.output as Output) : undefined));
// The output can report a failure itself; the header's badge and the title both read it.
const outputFailed = computed(() => !!output.value?.error);
const phase = computed(() =>
	getToolPhase(props.part.state, { streaming: props.streaming, approved: props.part.approval?.approved, failed: outputFailed.value }),
);

const subject = computed(() => (search.value ? `“${input.value.query ?? ""}”` : hostname(output.value?.url ?? input.value.url ?? "")));
const title = computed(() => {
	if (phase.value === "preparing" || phase.value === "running") return `${search.value ? "Searching" : "Reading"} ${subject.value}`;
	if (phase.value === "stopped") return `Did not finish ${subject.value}`;
	if (phase.value === "failed") return `Could not ${search.value ? "search" : "read"} ${subject.value}`;
	if (search.value) return `${output.value?.deep ? "Researched" : "Searched"} ${subject.value}`;
	return `Read ${subject.value}`;
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
		<ToolHeader
			:state="part.state"
			:tool-name="getToolName(part)"
			:title="title"
			:icon="search ? (output?.deep ? 'lucide-telescope' : 'lucide-search') : 'lucide-globe'"
			:streaming="streaming"
			:approved="part.approval?.approved"
			:failed="outputFailed"
		/>
		<ToolContent>
			<Source v-for="page in pages" :key="page.url" :href="page.url" :title="page.title" />
			<p v-if="output?.error" class="text-p-sm text-ink-gray-6">{{ output.error }}</p>
			<ToolOutput v-if="part.state === 'output-error'" :output="undefined" :error-text="part.errorText" />
		</ToolContent>
	</Tool>
</template>
