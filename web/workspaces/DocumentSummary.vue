<script setup lang="ts">
import { Button, Progress, Skeleton } from "frappe-ui";
import { computed } from "vue";
import { when } from "../dates";
import { count } from "../numbers";
import { pageCount, pageReadsLine, readyAt, typeLabel } from "./document-log";
import { failureCause, failureReason, fileSize, progressPercent, statusLabel, type LogEntry, type WorkspaceDocument } from "./documents";

/**
 * The top of a document's Details, what most people open them for: its type, pages and size
 * ("PDF · 398 pages · 2.3 MB"); its status, with a bar while it is Indexing, when it became
 * Ready, or why it failed and "Try again"; and one line on the pages a model read from
 * pictures. "Open file" shows the file in the panel. The status comes with the document; the
 * pages and the time come from its log (`log`), and wait for it as skeletons where they go.
 * The panel's stand-in draws it too, with no log and its buttons off (`standIn`).
 */
const props = defineProps<{ document: WorkspaceDocument; log: LogEntry[] | null; retrying?: boolean; standIn?: boolean }>();
const emit = defineEmits<{ retry: []; open: [] }>();

const isPdf = computed(() => props.document.mediaType === "application/pdf");
/** "PDF · 398 pages · 2.3 MB". A PDF's pages come with its log: null is a skeleton until then. Before it is parsed, there are none to count. */
const facts = computed(() => {
	const pages = props.log ? pageCount(props.log) : null;
	const pagesText = pages === null ? "" : `${count(pages)} ${pages === 1 ? "page" : "pages"}`;
	const parts: (string | null)[] = [typeLabel(props.document.mediaType) ?? "", isPdf.value && !props.log ? null : pagesText, fileSize(props.document.size)];
	return parts.filter((part) => part !== "");
});
const percent = computed(() => (props.document.status === "reading" ? progressPercent(props.document.progress) : null));
const ready = computed(() => (props.document.status === "ready" && props.log ? readyAt(props.log) : null));
const reads = computed(() => (props.log ? pageReadsLine(props.log, props.document.status === "reading") : null));
const cause = computed(() => (props.document.status === "failed" ? failureCause(props.document.error) : null));
</script>

<template>
	<section class="space-y-4" aria-label="Summary" data-slot="document-summary">
		<p class="text-p-sm tabular-nums text-ink-gray-6" data-slot="document-facts">
			<template v-for="(fact, index) in facts" :key="index">{{ index ? " · " : "" }}<Skeleton v-if="fact === null" class="inline-block h-2.5 w-14 rounded-4 align-middle" /><template v-else>{{ fact }}</template></template>
		</p>

		<div data-slot="document-status" :data-status="document.status">
			<template v-if="document.status === 'failed'">
				<p class="text-base text-ink-red-6">{{ failureReason(document.error) }}</p>
				<p v-if="cause" class="mt-0.5 break-words text-p-sm text-ink-gray-6" data-slot="document-cause">{{ cause }}</p>
			</template>
			<p v-else class="text-base tabular-nums text-ink-gray-8" data-slot="document-progress">
				{{ statusLabel(document) }}<span v-if="ready" class="text-ink-gray-6">{{ ` · ${when(ready)}` }}</span>
			</p>
			<Progress v-if="percent !== null" :value="percent" size="md" class="mt-2.5" :aria-label="statusLabel(document)" />
		</div>

		<div v-if="isPdf && !log" class="flex h-[1lh] items-center text-p-sm"><Skeleton class="h-2.5 w-48 max-w-full rounded-4" /></div>
		<p v-else-if="reads" class="text-p-sm tabular-nums text-ink-gray-6" data-slot="document-page-reads">
			<template v-if="reads.read">{{ reads.read }}</template><template v-if="reads.read && reads.unread"> · </template><span v-if="reads.unread" class="text-ink-red-6">{{ reads.unread }}</span>
		</p>

		<div class="flex flex-wrap gap-2 [@media(pointer:coarse)]:gap-3">
			<Button
				v-if="document.status === 'failed'"
				variant="solid"
				theme="gray"
				icon-left="lucide-rotate-ccw"
				label="Try again"
				class="touch-target"
				:loading="retrying"
				:disabled="standIn"
				@click="emit('retry')"
			/>
			<Button icon-left="lucide-eye" label="Open file" class="touch-target" :disabled="standIn" @click="emit('open')" />
		</div>
	</section>
</template>
