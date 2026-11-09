<script setup lang="ts">
import { Badge } from "frappe-ui";
import { computed, type Component } from "vue";
import { TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "../trace";
import { getStatusBadge, getToolIcon, getToolStatus, getToolTitle, humanizeToolName, type ToolState } from "./state";

const props = withDefaults(
	defineProps<{
		state: ToolState;
		/** Tool name, e.g. `get_doctype_schema`. Ignored when `title` is set. */
		toolName?: string;
		title?: string;
		/** Defaults to an icon guessed from `toolName`. */
		icon?: string | Component;
		streaming?: boolean;
		approved?: boolean;
		preliminary?: boolean;
		/** The output reports a failure itself, such as `{ ok: false }`: shown as an error, not "Done". */
		failed?: boolean;
		showBadge?: boolean;
	}>(),
	// approved stays undefined when not passed: Vue would cast a missing boolean to false, which reads as "denied".
	{ streaming: true, showBadge: true, approved: undefined },
);

const context = computed(() => ({ streaming: props.streaming, approved: props.approved, preliminary: props.preliminary, failed: props.failed }));
const status = computed(() => getToolStatus(props.state, context.value));
const label = computed(() => props.title ?? getToolTitle(props.state, humanizeToolName(props.toolName ?? "tool"), context.value));
const badge = computed(() => getStatusBadge(props.state, context.value));
const iconName = computed(() => (status.value === "error" ? "lucide-circle-x" : (props.icon ?? getToolIcon(props.toolName ?? ""))));
</script>

<template>
	<TraceCollapsibleTrigger data-slot="tool-header">
		<TraceLine :status="status">
			<TraceIcon :icon="iconName" />
			<TraceTitle :title="label">{{ label }}</TraceTitle>
			<Badge v-if="showBadge && badge.label !== 'Done'" size="sm" :theme="badge.theme" :label="badge.label" class="shrink-0" />
		</TraceLine>
	</TraceCollapsibleTrigger>
</template>
