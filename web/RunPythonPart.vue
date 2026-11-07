<script setup lang="ts">
import { computed } from "vue";
import { Attachment } from "./ai-elements/attachment";
import { viewOnClick } from "./ai-elements/file-viewer";
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from "./ai-elements/code-block";
import { getToolPhase, Tool, ToolContent, ToolHeader, ToolOutput, type ToolMessagePart } from "./ai-elements/tool";

/**
 * A run_python call (server/python/tool.ts): the code and what it printed, folded under a
 * Tool line, and the files it made below, always in view: images drawn, the rest as chips
 * to download.
 */
type Input = { code?: string; inputs?: { name: string; file_id?: string }[] };
type OutputFile = { name: string; url: string; media_type: string; size: number };
type Output = { ok?: boolean; stdout?: string; stderr?: string; files?: OutputFile[]; error?: string };

const props = defineProps<{ part: ToolMessagePart; streaming?: boolean }>();
const input = computed(() => (props.part.input ?? {}) as Input);
const output = computed(() => (props.part.state === "output-available" ? (props.part.output as Output) : undefined));
// The output can report a failure itself; the header's badge and the content both read it.
const outputFailed = computed(() => !!output.value?.error || output.value?.ok === false);
const phase = computed(() =>
	getToolPhase(props.part.state, { streaming: props.streaming, approved: props.part.approval?.approved, failed: outputFailed.value }),
);
const failed = computed(() => phase.value === "failed");

const title = computed(() => {
	if (phase.value === "preparing" || phase.value === "running") return "Running Python";
	if (phase.value === "stopped") return "Python did not finish";
	if (output.value?.error?.includes("was stopped")) return "Python was stopped";
	return failed.value ? "Python stopped with an error" : "Ran Python";
});
const images = computed(() => output.value?.files?.filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.media_type)) ?? []);
const others = computed(() => output.value?.files?.filter((file) => !images.value.includes(file)) ?? []);
const printed = computed(() => [output.value?.stdout, failed.value ? output.value?.error || output.value?.stderr : ""].filter(Boolean).join("\n").trim());
</script>

<template>
	<div class="flex flex-col gap-2">
		<Tool>
			<ToolHeader
				:state="part.state"
				tool-name="run_python"
				:title="title"
				icon="lucide-square-terminal"
				:streaming="streaming"
				:approved="part.approval?.approved"
				:failed="outputFailed"
			/>
			<ToolContent>
				<CodeBlock v-if="input.code" size="sm">
					<CodeBlockHeader>
						<CodeBlockTitle icon="lucide-file-code">main.py</CodeBlockTitle>
						<CodeBlockActions><CodeBlockCopyButton :value="input.code" /></CodeBlockActions>
					</CodeBlockHeader>
					<CodeBlockContent :code="input.code" language="python" />
				</CodeBlock>
				<CodeBlock v-if="printed" size="sm" :variant="failed ? 'destructive' : 'default'">
					<CodeBlockHeader><CodeBlockTitle icon="lucide-terminal">Output</CodeBlockTitle></CodeBlockHeader>
					<CodeBlockContent :code="printed" language="plaintext" />
				</CodeBlock>
				<ToolOutput v-if="part.state === 'output-error'" :output="undefined" :error-text="part.errorText" />
			</ToolContent>
		</Tool>
		<a
			v-for="image in images"
			:key="image.url"
			:href="image.url"
			target="_blank"
			rel="noopener"
			class="block w-fit max-w-full"
			@click="viewOnClick($event, { name: image.name, url: image.url, mediaType: image.media_type })"
		>
			<img :src="image.url" :alt="image.name" class="max-h-[420px] max-w-full rounded-6 border border-outline-gray-1" loading="lazy" />
		</a>
		<div v-if="others.length" class="flex flex-wrap gap-2">
			<Attachment
				v-for="file in others"
				:key="file.url"
				:name="file.name"
				:size="file.size"
				:media-type="file.media_type"
				:url="file.url"
				:download="file.name"
				state="done"
			/>
		</div>
	</div>
</template>
