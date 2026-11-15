<script lang="ts">
import type { Rule as SavedRule } from "./api";

// By "connector id/tool name", shared by the rows, as a search can remove a row and bring
// it back while its change is on its way: the newest change, and the rule the server has
// while changes are on their way (the rule before them, or the newest one saved).
const newestRule = new Map<string, number>();
const savedRule = new Map<string, { change: number; rule: SavedRule }>();
let ruleChanges = 0;
</script>

<script setup lang="ts">
import { Badge, Select } from "frappe-ui";
import { toast } from "../toasts";
import { computed } from "vue";
import { changeConnector, RULES, toolTitle, type Connector, type ConnectorTool, type Rule } from "./api";

const props = defineProps<{ connector: Connector; tool: ConnectorTool }>();

const rule = computed({
	get: () => props.tool.rule,
	set: (value: Rule) => void save(value),
});

async function save(value: Rule) {
	const key = `${props.connector.id}/${props.tool.name}`;
	const mine = ++ruleChanges;
	newestRule.set(key, mine);
	if (!savedRule.has(key)) savedRule.set(key, { change: 0, rule: props.tool.rule });
	// Shown at once; the server's answer replaces the connector (api.ts keeps only the newest answer).
	props.tool.rule = value;
	try {
		await changeConnector(props.connector.id, { rules: { [props.tool.name]: value } });
		const saved = savedRule.get(key);
		if (saved && mine > saved.change) savedRule.set(key, { change: mine, rule: value });
	} catch (error) {
		// Only the newest change goes back, to what the server has: a later change shows what the person chose last.
		if (newestRule.get(key) === mine) props.tool.rule = savedRule.get(key)?.rule ?? props.tool.rule;
		toast.error(error instanceof Error ? error.message : "The rule was not saved.");
	} finally {
		if (newestRule.get(key) === mine) savedRule.delete(key);
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
			<p v-if="tool.description" class="line-clamp-2 text-p-sm text-ink-gray-6" :title="tool.description">{{ tool.description }}</p>
		</div>
		<Select v-model="rule" :options="RULES" class="w-full shrink-0 sm:w-40" :aria-label="`When Ponder uses ${toolTitle(tool)}`" />
	</div>
</template>
