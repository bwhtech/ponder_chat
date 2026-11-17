<script setup lang="ts">
import { Dropdown, type DropdownOptions } from "frappe-ui";
import { computed, h } from "vue";
import WorkspaceChip from "./WorkspaceChip.vue";
import { kindIcon, workspaceById, workspaces } from "./store";

/**
 * The workspace of a new chat, chosen in the composer: none, or one of the person's
 * workspaces. Its own chunk, because it brings frappe-ui's Dropdown; WorkspaceChip.vue
 * stands in until it is here. The first message fixes the choice for good.
 */
const chosen = defineModel<string | null>({ required: true });
const workspace = computed(() => workspaceById(chosen.value));

const check = (on: boolean) => ({ suffix: () => (on ? h("span", { class: "lucide-check size-4 shrink-0 text-ink-gray-7" }) : null) });

const options = computed<DropdownOptions>(() => [
	{
		group: "No workspace",
		hideLabel: true,
		options: [{ label: "No workspace", onClick: () => (chosen.value = null), slots: check(!chosen.value) }],
	},
	{
		group: "Workspaces",
		hideLabel: true,
		options: workspaces.value.map((each) => ({ label: each.name, icon: kindIcon(each), onClick: () => (chosen.value = each.id), slots: check(chosen.value === each.id) })),
	},
]);
</script>

<template>
	<Dropdown :options="options" side="top" align="start">
		<WorkspaceChip :workspace="workspace" />
	</Dropdown>
</template>
