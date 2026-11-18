<script setup lang="ts">
import { Button, Dialog, Skeleton } from "frappe-ui";
import { computed, ref, shallowRef, watch } from "vue";
import { when } from "../../dates";
import EmptyState from "../../EmptyState.vue";
import { stepView } from "../../workspaces/document-log";
import { fileSize, statusLabel, type LogEntry } from "../../workspaces/documents";
import { admin, unwrap, type OrgDocument } from "../api";
import { money } from "../lib/format";

/**
 * One organisation document's indexing log (GET /api/admin/workspaces/:id/documents/:doc/log),
 * read only: each step, the pages a model read, the time, the cost and any error, in full
 * (web/workspaces/document-log.ts, stepView). Editors' Details show the same log in plain steps.
 */
const props = defineProps<{ workspaceId: string; document: OrgDocument | null }>();
const open = defineModel<boolean>("open", { required: true });

const steps = shallowRef<LogEntry[]>();
const loadError = ref("");
const views = computed(() => steps.value?.map((entry) => ({ entry, view: stepView(entry) })));

// Each load takes a number: a slow answer for a document no longer open is dropped.
let asked = 0;

watch(
	() => [open.value, props.document?.id],
	() => open.value && props.document && void load(),
	{ immediate: true },
);
// The page reads the report again while a document is Indexing (Workspaces.vue): when this
// one's status, cost or progress changes, its steps are read again, in place. The line at
// the top says how far it is ("Indexing… page 12 of 40").
watch(
	() => [props.document?.status, props.document?.costUsd, props.document?.progress?.done],
	() => open.value && props.document && void load({ quiet: true }),
);

async function load({ quiet = false } = {}) {
	const mine = ++asked;
	if (!quiet) steps.value = undefined;
	loadError.value = "";
	try {
		const param = { id: props.workspaceId, doc: props.document!.id };
		const log = await unwrap(admin.workspaces[":id"].documents[":doc"].log.$get({ param }), "The log could not load.");
		if (mine === asked) steps.value = log.steps;
	} catch (error) {
		if (mine === asked && !quiet) loadError.value = (error as Error).message;
	}
}
</script>

<template>
	<Dialog v-model:open="open" :title="document?.name ?? 'Document'" size="lg">
		<div v-if="document" class="space-y-4" data-slot="document-log">
			<p class="text-p-sm text-ink-gray-6">
				<span class="tabular-nums" :class="{ 'text-ink-red-6': document.status === 'failed' }" data-slot="document-progress">{{ statusLabel(document) }}</span>
				<span> · {{ fileSize(document.size) }} · Uploaded {{ when(document.createdAt) }}</span>
				<span v-if="document.costUsd !== null"> · {{ money(document.costUsd) }} to index</span>
			</p>

			<EmptyState v-if="loadError" icon="lucide-circle-alert" title="The log could not load" :body="loadError" alert class="!py-8">
				<Button label="Try again" @click="load()" />
			</EmptyState>
			<ol v-else-if="!views" class="divide-y divide-outline-gray-1" aria-busy="true" aria-label="Loading the steps">
				<li v-for="width in ['w-24', 'w-32', 'w-28', 'w-20']" :key="width" class="py-2.5">
					<div class="flex h-[1lh] items-center justify-between text-sm"><Skeleton :class="['h-3 rounded-4', width]" /><Skeleton class="h-3 w-12 rounded-4" /></div>
					<div class="flex h-[1lh] items-center text-p-sm"><Skeleton class="h-2.5 w-48 max-w-full rounded-4" /></div>
				</li>
			</ol>
			<ol v-else class="divide-y divide-outline-gray-1" aria-label="Steps" data-slot="document-log-steps">
				<li v-for="({ entry, view }, index) in views" :key="`${entry.generation}:${entry.step}:${index}`" class="py-2.5" :data-step="entry.step">
					<div class="flex items-baseline justify-between gap-3">
						<p class="min-w-0 text-sm" :class="view.tone === 'failed' ? 'text-ink-red-6' : 'text-ink-gray-8'">{{ view.title }}</p>
						<p class="shrink-0 text-sm tabular-nums text-ink-gray-6">
							{{ view.time }}<template v-if="view.cost"> · {{ view.cost }}</template>
						</p>
					</div>
					<p v-if="view.facts" class="break-words text-p-sm text-ink-gray-6">{{ view.facts }}</p>
					<p v-if="view.error" class="mt-0.5 break-words text-p-sm text-ink-red-6">{{ view.error }}</p>
				</li>
			</ol>

			<div class="flex justify-end pt-2">
				<Button label="Close" @click="open = false" />
			</div>
		</div>
	</Dialog>
</template>
