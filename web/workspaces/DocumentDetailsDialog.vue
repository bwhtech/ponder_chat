<script setup lang="ts">
import { Button, Dialog, Skeleton } from "frappe-ui";
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { when } from "../dates";
import EmptyState from "../EmptyState.vue";
import { toast } from "../toasts";
import { dialogTitle, workspaceDialog, type WorkspaceDialogRequest } from "./dialogs";
import { readingOrder, stepView } from "./document-log";
import { DETAILS_NOTE, fetchDocumentLog, fileSize, retryDocument, STATUS_LABELS, type LogEntry, type WorkspaceDocument } from "./documents";

/**
 * A document's Details, for people who can edit the workspace: the indexing log in order
 * (server/workspaces/documents/log.ts), with the pages a model read and why, the time and
 * cost of each step, and any error. A failed document offers "Try again". While it is
 * Reading, the log is read again every few seconds, and the side panel hears of each change.
 */
const props = defineProps<{ request: Extract<WorkspaceDialogRequest, { kind: "document" }> }>();
const open = computed({ get: () => workspaceDialog.open, set: (value) => (workspaceDialog.open = value) });

const POLL_MS = 2000;
const doc = shallowRef<WorkspaceDocument>(props.request.document);
const steps = shallowRef<LogEntry[]>();
const loadError = ref("");
const retrying = ref(false);
const views = computed(() => steps.value && readingOrder(steps.value).map((entry) => ({ entry, view: stepView(entry) })));
let timer: ReturnType<typeof setTimeout> | undefined;
let closed = false;

void load();
onBeforeUnmount(() => {
	closed = true;
	clearTimeout(timer);
});

async function load() {
	clearTimeout(timer);
	loadError.value = "";
	try {
		const log = await fetchDocumentLog(props.request.workspaceId, doc.value.id);
		if (closed) return;
		steps.value = log.steps;
		changed(log.document);
	} catch (error) {
		if (closed) return;
		// A poll that fails keeps the steps it has; only a first load shows the error.
		if (!steps.value) loadError.value = (error as Error).message;
	}
	if (!closed && doc.value.status === "reading") timer = setTimeout(load, POLL_MS);
}

function changed(next: WorkspaceDocument) {
	const before = doc.value;
	doc.value = next;
	if (before.status !== next.status || before.error !== next.error) props.request.onChanged(next);
}

async function retry() {
	retrying.value = true;
	try {
		changed(await retryDocument(props.request.workspaceId, doc.value.id));
		await load();
	} catch (error) {
		toast.error((error as Error).message);
	} finally {
		retrying.value = false;
	}
}

function retryFirstLoad() {
	steps.value = undefined;
	void load();
}
</script>

<template>
	<Dialog v-model:open="open" :title="dialogTitle(request)" size="lg">
		<div class="space-y-4" data-slot="document-details">
			<p class="text-p-sm text-ink-gray-6">
				<span :class="{ 'text-ink-red-6': doc.status === 'failed' }" data-slot="document-details-status">{{ STATUS_LABELS[doc.status] }}</span>
				<span> · {{ fileSize(doc.size) }} · Uploaded {{ when(doc.createdAt) }}</span>
			</p>

			<EmptyState v-if="loadError" icon="lucide-wifi-off" title="The details could not load" :body="loadError" alert class="!py-8">
				<Button label="Try again" @click="retryFirstLoad" />
			</EmptyState>
			<template v-else>
				<ol v-if="!views" class="divide-y divide-outline-gray-1" aria-busy="true" aria-label="Loading the steps">
					<li v-for="width in ['w-24', 'w-32', 'w-28', 'w-20']" :key="width" class="py-2.5">
						<div class="flex h-[1lh] items-center justify-between text-sm"><Skeleton :class="['h-3 rounded-4', width]" /><Skeleton class="h-3 w-12 rounded-4" /></div>
						<div class="flex h-[1lh] items-center text-p-sm"><Skeleton class="h-2.5 w-48 max-w-full rounded-4" /></div>
					</li>
				</ol>
				<ol v-else class="divide-y divide-outline-gray-1" aria-label="Steps" data-slot="document-steps">
					<li v-for="({ entry, view }, index) in views" :key="`${entry.generation}:${entry.step}:${index}`" class="py-2.5" data-slot="document-step" :data-step="entry.step">
						<div class="flex items-baseline justify-between gap-3">
							<p class="min-w-0 text-sm" :class="view.tone === 'failed' ? 'text-ink-red-6' : 'text-ink-gray-8'">{{ view.title }}</p>
							<p class="shrink-0 text-sm tabular-nums text-ink-gray-6">
								{{ [view.time, view.cost].filter(Boolean).join(" · ") }}
							</p>
						</div>
						<p v-if="view.facts" class="break-words text-p-sm text-ink-gray-6">{{ view.facts }}</p>
						<p v-if="view.error" class="mt-0.5 break-words text-p-sm text-ink-red-6" data-slot="document-step-error">{{ view.error }}</p>
					</li>
				</ol>
			</template>

			<p class="text-p-sm text-ink-gray-5">{{ DETAILS_NOTE }}</p>

			<div class="flex justify-end gap-2 pt-2">
				<Button label="Close" @click="open = false" />
				<Button v-if="doc.status === 'failed'" variant="solid" theme="gray" icon-left="lucide-rotate-ccw" label="Try again" :loading="retrying" @click="retry" />
			</div>
		</div>
	</Dialog>
</template>
