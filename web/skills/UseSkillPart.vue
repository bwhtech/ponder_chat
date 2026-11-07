<script setup lang="ts">
import { computed } from "vue";
import { getToolName, getToolPhase, Tool, ToolContent, ToolHeader, ToolOutput, type ToolMessagePart } from "../ai-elements/tool";
import { skillDescription, skillTitle } from "./skills";

/** A use_skill call (server/workflow/skills.ts): Ponder chose a skill on its own. One line, with what the skill is for below. */
const props = defineProps<{ part: ToolMessagePart; streaming?: boolean }>();
const name = computed(() => String((props.part.input as { name?: string } | undefined)?.name ?? ""));
const phase = computed(() => getToolPhase(props.part.state, { streaming: props.streaming, approved: props.part.approval?.approved }));
const title = computed(() => {
	const skill = name.value ? skillTitle(name.value) : "a skill";
	if (phase.value === "preparing" || phase.value === "running") return `Loading skill ${skill}`;
	if (phase.value === "failed" || phase.value === "stopped") return `Could not load skill ${skill}`;
	return `Picked skill ${skill}`;
});
const description = computed(() => skillDescription(name.value));
</script>

<template>
	<Tool>
		<ToolHeader
			:state="part.state"
			:tool-name="getToolName(part)"
			:title="title"
			icon="lucide-sparkles"
			:streaming="streaming"
			:approved="part.approval?.approved"
		/>
		<ToolContent>
			<p class="text-p-sm text-ink-gray-6">Ponder chose this skill for the question.<template v-if="description"> {{ description }}</template></p>
			<ToolOutput v-if="part.state === 'output-error'" :output="undefined" :error-text="part.errorText" />
		</ToolContent>
	</Tool>
</template>
