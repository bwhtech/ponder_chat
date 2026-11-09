<script setup lang="ts">
import { Skeleton } from "frappe-ui";
import { computed, onMounted, ref, shallowRef } from "vue";
import { delimiterFor, isNumericColumn, parseDelimited, type ParsedTable } from "./csv";

/**
 * A CSV or TSV file as a table: the first row is the header and stays in view while
 * the rest scrolls. Plain values only: no formulas, sorting or editing.
 */
const props = defineProps<{ url: string; name: string; mediaType: string }>();
const emit = defineEmits<{ rows: [count: number] }>();

/** More rows than this make the page slow; the file can still be downloaded whole. */
const ROW_LIMIT = 2_000;

const table = shallowRef<ParsedTable | null>(null);
const failed = ref(false);

const header = computed(() => table.value?.rows[0] ?? []);
const body = computed(() => table.value?.rows.slice(1) ?? []);
const width = computed(() => Math.max(0, ...(table.value?.rows.map((row) => row.length) ?? [0])));
const numeric = computed(() => Array.from({ length: width.value }, (_, column) => isNumericColumn(body.value.slice(0, 200), column)));

onMounted(async () => {
	try {
		const response = await fetch(props.url);
		if (!response.ok) throw new Error(String(response.status));
		table.value = parseDelimited(await response.text(), delimiterFor(props.name, props.mediaType), ROW_LIMIT + 1);
		emit("rows", body.value.length + table.value.more);
	} catch {
		failed.value = true;
	}
});
</script>

<template>
	<div v-if="failed" class="flex flex-col items-center gap-2 px-6 pt-[20vh] text-center">
		<p class="text-base text-ink-gray-7">This file could not be shown.</p>
		<a :href="url" :download="name" class="text-sm-medium text-ink-gray-8 underline underline-offset-2">Download it</a>
	</div>
	<div v-else-if="!table" class="flex flex-col gap-2 p-4">
		<Skeleton v-for="line in 8" :key="line" class="h-6 w-full rounded-2" />
	</div>
	<p v-else-if="!table.rows.length" class="px-6 pt-[20vh] text-center text-base text-ink-gray-6">This file is empty.</p>
	<div v-else class="min-w-full">
		<table class="w-max min-w-full border-separate border-spacing-0 text-base text-ink-gray-7">
			<thead>
				<tr>
					<th class="sticky left-0 top-0 z-20 w-12 border-b border-r border-outline-gray-2 bg-surface-gray-1" aria-label="Row" />
					<th
						v-for="column in width"
						:key="column"
						class="sticky top-0 z-10 max-w-[20rem] truncate border-b border-r border-outline-gray-2 bg-surface-gray-1 px-3 py-2 text-left text-sm-medium text-ink-gray-8 last:border-r-0"
						:class="{ 'text-right': numeric[column - 1] }"
						:title="header[column - 1]"
					>
						{{ header[column - 1] }}
					</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="(row, index) in body" :key="index" class="hover:bg-surface-gray-1">
					<td class="sticky left-0 border-b border-r border-outline-gray-1 bg-surface-base px-2 py-1.5 text-right text-sm tabular-nums text-ink-gray-4">
						{{ index + 1 }}
					</td>
					<td
						v-for="column in width"
						:key="column"
						class="max-w-[20rem] truncate border-b border-r border-outline-gray-1 px-3 py-1.5 last:border-r-0"
						:class="{ 'text-right tabular-nums': numeric[column - 1] }"
						:title="row[column - 1]"
					>
						{{ row[column - 1] }}
					</td>
				</tr>
			</tbody>
		</table>
		<p v-if="table.more" class="px-4 py-3 text-sm text-ink-gray-5">
			Showing the first {{ body.length.toLocaleString() }} rows of {{ (body.length + table.more).toLocaleString() }}. Download the file to see them all.
		</p>
	</div>
</template>
