<script setup lang="ts">
import { Button, Dialog, Skeleton } from "frappe-ui";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { ApiError } from "../api";
import EmptyState from "../EmptyState.vue";
import { toast } from "../toasts";
import { dialogTitle, useFrameFocus, workspaceDialog, type WorkspaceDialogRequest } from "./dialogs";
import { plainSteps } from "./document-log";
import { fetchDocumentLog, retryDocument, type LogEntry, type WorkspaceDocument } from "./documents";
import { Poller } from "./poller";

/**
 * A document's Details, for people who can edit the workspace: the indexing log in plain
 * steps (document-log.ts, plainSteps), such as the pages read from a picture, and what went
 * wrong. Models, times and costs are the admin's (/admin/workspaces). A failed document
 * offers "Try again". While it is Indexing and the dialog is open, the log is read again
 * every few seconds, and the side panel hears of each change. Closing the dialog keeps it
 * mounted for its transition, so the polls stop on close, not on unmount.
 */
const props = defineProps<{ request: Extract<WorkspaceDialogRequest, { kind: "document" }> }>();
const open = computed({ get: () => workspaceDialog.open, set: (value) => (workspaceDialog.open = value) });

const POLL_MS = 2000;
const doc = shallowRef<WorkspaceDocument>(props.request.document);
const steps = shallowRef<LogEntry[]>();
const loadError = ref("");
const retrying = ref(false);
const shown = computed(() => steps.value && plainSteps(steps.value));
const poller = new Poller(load);
useFrameFocus();

poller.start(0);
watch(open, (now) => {
	if (!now) poller.stop();
});
onBeforeUnmount(() => poller.stop());

/** Reads the log; the wait before reading it again, or null. */
async function load(current: () => boolean) {
	loadError.value = "";
	try {
		const log = await fetchDocumentLog(props.request.workspaceId, doc.value.id);
		if (!current()) return null;
		steps.value = log.steps;
		changed(log.document);
	} catch (error) {
		if (!current()) return null;
		// A poll that fails keeps the steps it has; only a first load shows the error.
		if (!steps.value) loadError.value = (error as Error).message;
		// Deleted, or the person may no longer edit the workspace: asking again will not help.
		if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
	}
	return open.value && doc.value.status === "reading" ? POLL_MS : null;
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
		poller.start(0);
	} catch (error) {
		toast.error((error as Error).message);
	} finally {
		retrying.value = false;
	}
}

function retryFirstLoad() {
	steps.value = undefined;
	poller.start(0);
}
</script>

<template>
	<Dialog v-model:open="open" :title="dialogTitle(request)" size="lg">
		<div class="space-y-4" data-slot="document-details">
			<EmptyState v-if="loadError" icon="lucide-circle-alert" title="The details could not load" :body="loadError" alert class="!py-8">
				<Button label="Try again" @click="retryFirstLoad" />
			</EmptyState>
			<ol v-else-if="!shown" class="space-y-3" aria-busy="true" aria-label="Loading the steps">
				<li v-for="width in ['w-36', 'w-44', 'w-20']" :key="width" class="flex h-[1lh] items-center text-sm"><Skeleton :class="['h-3 rounded-4', width]" /></li>
			</ol>
			<ol v-else class="space-y-3" aria-label="Steps" data-slot="document-steps">
				<li v-for="(step, index) in shown" :key="index" data-slot="document-step" :data-step="step.step">
					<p class="text-sm" :class="step.failed ? 'text-ink-red-6' : 'text-ink-gray-8'">
						{{ step.title }}<span v-if="step.facts" class="text-ink-gray-6">{{ ` · ${step.facts}` }}</span>
					</p>
					<p v-if="step.error" class="mt-0.5 break-words text-p-sm text-ink-gray-6" data-slot="document-step-error">{{ step.error }}</p>
				</li>
			</ol>

			<div class="flex justify-end gap-2 pt-2">
				<Button label="Close" @click="open = false" />
				<Button v-if="doc.status === 'failed'" variant="solid" theme="gray" icon-left="lucide-rotate-ccw" label="Try again" :loading="retrying" @click="retry" />
			</div>
		</div>
	</Dialog>
</template>
