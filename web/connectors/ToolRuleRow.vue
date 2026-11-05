<script setup lang="ts">
import { Badge, Select, toast } from "frappe-ui";
import { computed } from "vue";
import { changeConnector, RULES, toolTitle, type Connector, type ConnectorTool, type Rule } from "./api";

const props = defineProps<{ connector: Connector; tool: ConnectorTool }>();

const rule = computed({
	get: () => props.tool.rule,
	set: (value: Rule) => void save(value),
});

async function save(value: Rule) {
	const before = props.tool.rule;
	// Shown at once; the server's answer replaces the connector.
	props.tool.rule = value;
	try {
		await changeConnector(props.connector.id, { rules: { [props.tool.name]: value } });
	} catch (error) {
		props.tool.rule = before;
		toast.error(error instanceof Error ? error.message : "The rule was not saved.");
	}
}
</script>

<template>
	<div class="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:gap-4">
		<div class="min-w-0 flex-1">
			<div class="flex min-w-0 items-center gap-2">
				<span class="truncate text-base" :class="rule === 'off' ? 'text-ink-gray-5' : 'text-ink-gray-8'" :title="`${toolTitle(tool)} (${tool.name})`">{{ toolTitle(tool) }}</span>
				<Badge v-if="tool.readOnly" label="Read-only" size="sm" variant="subtle" theme="gray" class="shrink-0" />
			</div>
			<p v-if="tool.description" class="line-clamp-2 text-p-sm text-ink-gray-5" :title="tool.description">{{ tool.description }}</p>
		</div>
		<Select v-model="rule" :options="RULES" class="w-full shrink-0 sm:w-40" :aria-label="`When Ponder uses ${toolTitle(tool)}`" />
	</div>
</template>
