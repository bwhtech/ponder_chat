<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { ApiError } from "../api";
import EmptyState from "../EmptyState.vue";
import { panelItem, viewInPanel, type DocumentDetailsRequest } from "../side-panel/panel";
import { toast } from "../toasts";
import { plainSteps } from "./document-log";
import DocumentSummary from "./DocumentSummary.vue";
import { documentFile, fetchDocumentLog, retryDocument, type LogEntry, type WorkspaceDocument } from "./documents";
import { Poller } from "./poller";

/**
 * A document's Details, in the side panel, for people who can edit the workspace. First the
 * summary (DocumentSummary.vue): what the file is, its status and how far it is, and the pages
 * a model read. The log, in plain steps (document-log.ts, plainSteps), shows when the Log
 * button in the panel's header is on (`logOpen`). Models, times and costs are the admin's
 * (/admin/workspaces). While the document is Indexing, its log is read again every few
 * seconds, until it settles or the panel closes or shows something else. The row hears of
 * each change of status, and Details follow a change the row sees first, such as its own
 * "Try again".
 */
const props = defineProps<{ request: DocumentDetailsRequest; logOpen: boolean }>();

const POLL_MS = 2000;
const key = panelItem.value?.key;
const doc = shallowRef<WorkspaceDocument>(props.request.document);
const log = shallowRef<LogEntry[] | null>(null);
const loadError = ref("");
const retrying = ref(false);
const steps = computed(() => log.value && plainSteps(log.value));
const poller = new Poller(load);

poller.start(0);
// Closed, or showing something else: the panel keeps this mounted while it slides out.
watch(panelItem, (item) => item?.key !== key && poller.stop());
watch(props.request.current, (next) => {
	if (!next || (next.status === doc.value.status && next.error === doc.value.error)) return;
	doc.value = next;
	if (next.status === "reading") poller.start(0);
});
onBeforeUnmount(() => poller.stop());

/** Reads the log; the wait before reading it again, or null. */
async function load(current: () => boolean) {
	loadError.value = "";
	try {
		const answer = await fetchDocumentLog(props.request.workspaceId, doc.value.id);
		if (!current()) return null;
		log.value = answer.steps;
		changed(answer.document);
	} catch (error) {
		if (!current()) return null;
		// A poll that fails keeps the steps it has; only a first load shows the error.
		if (!log.value) loadError.value = (error as Error).message;
		// Deleted, or the person may no longer edit the workspace: asking again will not help.
		if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
	}
	return doc.value.status === "reading" ? POLL_MS : null;
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
	loadError.value = "";
	poller.start(0);
}

/** The file takes the panel's place; one the panel can't show opens in a new tab. */
function openFile() {
	const file = documentFile(props.request.workspaceId, doc.value);
	if (!viewInPanel(file)) window.open(file.url, "_blank", "noopener");
}
</script>

<template>
	<div class="space-y-6 px-4 pb-10 pt-5 sm:px-5" data-slot="document-details">
		<DocumentSummary :document="doc" :log="loadError ? [] : log" :retrying="retrying" @retry="retry" @open="openFile" />

		<EmptyState v-if="loadError" icon="lucide-circle-alert" title="The details could not load" :body="loadError" alert class="!py-8">
			<Button label="Try again" @click="retryFirstLoad" />
		</EmptyState>

		<section v-else-if="logOpen" id="document-log" class="space-y-3 border-t border-outline-gray-1 pt-5" aria-labelledby="document-log-heading" data-slot="document-log">
			<h3 id="document-log-heading" class="text-base-semibold text-ink-gray-9">Log</h3>
			<ol v-if="!steps" class="space-y-3" aria-busy="true" aria-label="Loading the steps">
				<li v-for="width in ['w-36', 'w-44', 'w-20']" :key="width" class="flex h-[1lh] items-center text-sm"><Skeleton :class="['h-3 rounded-4', width]" /></li>
			</ol>
			<ol v-else class="space-y-3" aria-label="Steps" data-slot="document-steps">
				<li v-for="(step, index) in steps" :key="index" data-slot="document-step" :data-step="step.step">
					<p class="text-sm" :class="step.failed ? 'text-ink-red-6' : 'text-ink-gray-8'">
						{{ step.title }}<span v-if="step.facts" class="text-ink-gray-6">{{ ` · ${step.facts}` }}</span>
					</p>
					<p v-if="step.pages" class="mt-0.5 break-words text-p-sm tabular-nums text-ink-gray-6" data-slot="document-step-pages">{{ step.pages }}</p>
					<p v-if="step.error" class="mt-0.5 break-words text-p-sm text-ink-gray-6" data-slot="document-step-error">{{ step.error }}</p>
				</li>
			</ol>
		</section>
	</div>
</template>
