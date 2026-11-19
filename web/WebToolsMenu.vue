<script setup lang="ts">
import { Dropdown, type DropdownOptions } from "frappe-ui";
import { computed, h } from "vue";
import { scopeRows } from "./web-scope";
import WebToolsChip from "./WebToolsChip.vue";

/**
 * Where the answer comes from, chosen in the message box (web-tools.ts): one of three, with
 * one check. Web on or off stays for the chat. Deep research takes in both (Sources, then a
 * deep web search) and is for the next message only: after it, the chat is back on its choice. Its own chunk, because it brings
 * frappe-ui's Dropdown; WebToolsChip.vue stands in until it is here.
 */
const props = defineProps<{ inWorkspace?: boolean; disabled?: boolean }>();
const web = defineModel<boolean>("web", { required: true });
const research = defineModel<boolean>("research", { required: true });

const check = (on: boolean) => () => (on ? h("span", { class: "lucide-check size-4 shrink-0 text-ink-gray-7" }) : null);
/** The row's name and what it does, in tones people can read (the menu's own description is gray-5). */
const label = (row: { label: string; description: string }) => () =>
	h("div", { class: "min-w-0" }, [h("div", { class: "truncate leading-tighter text-ink-gray-8" }, row.label), h("div", { class: "truncate text-p-sm text-ink-gray-6" }, row.description)]);

const options = computed<DropdownOptions>(() => {
	const rows = scopeRows(Boolean(props.inWorkspace));
	const row = (key: keyof typeof rows, on: boolean, onClick: () => void) => ({ label: rows[key].label, icon: rows[key].icon, onClick, slots: { label: label(rows[key]), suffix: check(on) } });
	const choose = (on: boolean) => () => {
		web.value = on;
		research.value = false;
	};
	const off = row("off", !research.value && !web.value, choose(false));
	const search = row("web", !research.value && web.value, choose(true));
	return [
		// The chat's default first: off in a workspace, on elsewhere.
		...(props.inWorkspace ? [off, search] : [search, off]),
		row("research", research.value, () => (research.value = true)),
	];
});
</script>

<template>
	<Dropdown :options="options" side="top" align="start">
		<WebToolsChip :web="web" :research="research" :in-workspace="inWorkspace" :disabled="disabled" />
	</Dropdown>
</template>
