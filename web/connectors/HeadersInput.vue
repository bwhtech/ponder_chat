<script setup lang="ts">
import { Button, Password, TextInput } from "frappe-ui";
import type { Header } from "./api";

/** Header rows for servers that take an API key. Values are saved encrypted, and never shown again. */
const rows = defineModel<Header[]>({ default: () => [] });
withDefaults(defineProps<{ namesFixed?: boolean }>(), { namesFixed: false });

function add() {
	rows.value = [...rows.value, { name: "", value: "" }];
}
function remove(index: number) {
	rows.value = rows.value.filter((_, i) => i !== index);
}
</script>

<template>
	<div class="space-y-2">
		<div v-if="rows.length" class="flex gap-2 text-xs text-ink-gray-5" aria-hidden="true">
			<span class="w-40 shrink-0">Header</span>
			<span>Value</span>
		</div>
		<div v-for="(row, index) in rows" :key="index" class="flex items-center gap-2">
			<TextInput v-model="row.name" :disabled="namesFixed" placeholder="Authorization" aria-label="Header" autocomplete="off" class="w-40 shrink-0" />
			<Password v-model="row.value" placeholder="Bearer sk-…" :aria-label="`Value of ${row.name || 'the header'}`" autocomplete="off" class="min-w-0 flex-1" />
			<Button v-if="!namesFixed" variant="ghost" icon="lucide-x" :aria-label="`Remove ${row.name || 'this header'}`" @click="remove(index)" />
		</div>
		<Button v-if="!namesFixed" size="sm" variant="subtle" icon-left="lucide-plus" label="Add header" @click="add" />
	</div>
</template>
