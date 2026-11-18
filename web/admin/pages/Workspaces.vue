<script setup lang="ts">
import { displayName } from "../../../shared/display-name";
import { Button, PageHeader, PageHeaderMobile } from "frappe-ui";
import { NumberCard } from "frappe-ui/charts";
import { List, ListCell, ListHeader, ListHeaderCell, ListRow, ListRows } from "frappe-ui/list";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { admin, unwrap, type OrgDocument, type OrgWorkspace, type WorkspacesReport } from "../api";
import AccountMenu from "../components/AccountMenu.vue";
import DocumentLogDialog from "../components/DocumentLogDialog.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import PrivacyNote from "../components/PrivacyNote.vue";
import EmptyState from "../../EmptyState.vue";
import { count } from "../../numbers";
import { fileSize, STATUS_LABELS } from "../../workspaces/documents";
import { Poller } from "../../workspaces/poller";
import { money } from "../lib/format";
import { isMobile } from "../lib/viewport";

/**
 * Workspaces (server/workspaces/admin.ts). Organisation workspaces in full: owner,
 * documents, their status and indexing cost, and each document's log. Private workspaces
 * as totals only: the server sends no name, document or owner of one.
 */
const report = ref<WorkspacesReport | null>(null);
const status = ref<{ kind: "loading" } | { kind: "loaded" } | { kind: "error"; message: string }>({ kind: "loading" });
const loading = computed(() => status.value.kind === "loading");
const privateTotals = computed(() => report.value?.private);

async function load() {
	status.value = { kind: "loading" };
	try {
		report.value = await unwrap(admin.workspaces.$get(), "The workspaces could not load.");
		status.value = { kind: "loaded" };
	} catch (e) {
		status.value = { kind: "error", message: (e as Error).message };
	}
}
void load();

/**
 * While an organisation document is Indexing, the report is read again every few seconds, so
 * its status and cost, and the log open on it, follow the indexing. A failed read changes
 * nothing; the next one tries again. None runs once the page is left (poller.ts).
 */
const POLL_MS = 4000;
const reading = computed(() => Boolean(report.value?.org.some((workspace) => workspace.documents.some((document) => document.status === "reading"))));
const poller = new Poller(async (current) => {
	try {
		const fresh = await unwrap(admin.workspaces.$get(), "The workspaces could not load.");
		if (current()) report.value = fresh;
	} catch {
		// Offline for a moment: the next read tries again.
	}
	return current() && reading.value ? POLL_MS : null;
});
watch(reading, (now) => (now ? poller.start(POLL_MS) : poller.stop()));
onBeforeUnmount(() => poller.stop());

const logOpen = ref(false);
const logOf = ref<{ workspaceId: string; documentId: string } | null>(null);
// From the report, so the log shows the document as it is now.
const logDocument = computed(() => {
	const workspace = report.value?.org.find((other) => other.id === logOf.value?.workspaceId);
	return workspace?.documents.find((document) => document.id === logOf.value?.documentId) ?? null;
});
function openLog(workspace: OrgWorkspace, document: OrgDocument) {
	logOf.value = { workspaceId: workspace.id, documentId: document.id };
	logOpen.value = true;
}

const ownerName = (workspace: OrgWorkspace) => (workspace.owner.email ? displayName(workspace.owner.name, workspace.owner.email) : workspace.owner.name) || "Removed account";
const documentCount = (n: number) => (n === 1 ? "1 document" : `${count(n)} documents`);
const cost = (usd: number | null) => (usd === null ? "—" : money(usd));
const statusTone = (document: OrgDocument) => (document.status === "failed" ? "text-ink-red-6" : document.status === "reading" ? "text-ink-gray-6" : "text-ink-gray-8");
</script>

<template>
	<PageHeaderMobile v-if="isMobile" title="Workspaces">
		<template #prefix><AccountMenu compact /></template>
	</PageHeaderMobile>
	<PageHeader v-else>
		<div class="mx-auto flex w-full max-w-[61.5rem] items-center gap-2">
			<h1 class="text-lg-semibold text-ink-gray-9">Workspaces</h1>
		</div>
	</PageHeader>

	<div class="mx-auto w-full max-w-5xl space-y-8 px-3 pb-16 pt-4 sm:px-5 md:pt-6">
		<EmptyState v-if="status.kind === 'error'" icon="lucide-circle-alert" title="The workspaces could not load" :body="status.message" alert>
			<Button label="Try again" @click="load" />
		</EmptyState>

		<template v-else>
			<section aria-label="Organisation workspaces" class="space-y-3" data-slot="org-workspaces">
				<h2 class="text-base-semibold text-ink-gray-9">Organisation workspaces</h2>
				<ListSkeleton v-if="loading" :rows="4" :avatar="false" two-lines label="Loading workspaces" />
				<EmptyState
					v-else-if="!report?.org.length"
					icon="lucide-building-2"
					title="No organisation workspaces yet"
					body="Make one in the chat with New workspace."
				/>
				<div v-else class="space-y-8">
					<article v-for="workspace in report.org" :key="workspace.id" class="space-y-2" data-slot="org-workspace" :aria-label="workspace.name">
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0 space-y-0.5">
								<h3 class="truncate text-base-medium text-ink-gray-8">{{ workspace.name }}</h3>
								<p class="text-sm text-ink-gray-6">
									{{ ownerName(workspace) }} · {{ documentCount(workspace.documents.length) }}
								</p>
							</div>
							<Button class="shrink-0" label="Open" icon-right="lucide-arrow-up-right" :link="`/?w=${encodeURIComponent(workspace.slug)}`" />
						</div>

						<p v-if="!workspace.documents.length" class="text-p-sm text-ink-gray-6">No documents yet.</p>
						<!-- Phone: a feed, the status, size and cost under the name. -->
						<List v-else-if="isMobile" :columns="['minmax(0,1fr)', 'auto']" class="-mx-3 list-row-px-3">
							<ListRows :items="workspace.documents" v-slot="{ item }">
								<ListRow class="py-3" @click="openLog(workspace, item)">
									<ListCell class="flex-col items-stretch gap-0.5">
										<span class="truncate text-base text-ink-gray-8">{{ item.name }}</span>
										<span class="truncate text-sm text-ink-gray-6">
											<span :class="statusTone(item)">{{ STATUS_LABELS[item.status] }}</span> · {{ fileSize(item.size) }} · {{ cost(item.costUsd) }}
										</span>
										<span v-if="item.error" class="line-clamp-2 text-sm text-ink-red-6">{{ item.error }}</span>
									</ListCell>
									<ListCell><span class="lucide-chevron-right size-4 text-ink-gray-4" aria-hidden="true" /></ListCell>
								</ListRow>
							</ListRows>
						</List>
						<div v-else class="scroll-fade-x scrollbar-thin -mx-3 overflow-x-auto [--scroll-fade-range:24px] [--scroll-fade-size:24px]">
							<List :columns="['minmax(0,1fr)', '7rem', '6rem', '7rem', '1.5rem']" class="min-w-[40rem] list-row-px-3">
								<ListHeader>
									<ListHeaderCell>Document</ListHeaderCell>
									<ListHeaderCell>Status</ListHeaderCell>
									<ListHeaderCell class="justify-end">Size</ListHeaderCell>
									<ListHeaderCell class="justify-end">Cost to index</ListHeaderCell>
									<ListHeaderCell><span class="sr-only">Log</span></ListHeaderCell>
								</ListHeader>
								<ListRows :items="workspace.documents" v-slot="{ item }">
									<ListRow class="min-h-[52px] py-2" @click="openLog(workspace, item)" :data-document="item.name">
										<ListCell>
											<div class="min-w-0">
												<div class="truncate text-base text-ink-gray-8">{{ item.name }}</div>
												<div v-if="item.error" class="truncate text-sm text-ink-red-6" :title="item.error">{{ item.error }}</div>
											</div>
										</ListCell>
										<ListCell class="text-sm" :class="statusTone(item)">{{ STATUS_LABELS[item.status] }}</ListCell>
										<ListCell class="justify-end text-sm tabular-nums text-ink-gray-7">{{ fileSize(item.size) }}</ListCell>
										<ListCell class="justify-end text-sm tabular-nums text-ink-gray-7">{{ cost(item.costUsd) }}</ListCell>
										<ListCell class="justify-end"><span class="lucide-chevron-right size-4 text-ink-gray-4" aria-hidden="true" /></ListCell>
									</ListRow>
								</ListRows>
							</List>
						</div>
					</article>
				</div>
			</section>

			<section aria-label="Private workspaces" class="space-y-3" data-slot="private-workspaces">
				<h2 class="text-base-semibold text-ink-gray-9">Private workspaces</h2>
				<div data-slot="dashboard" class="grid grid-cols-2 gap-4 lg:grid-cols-4">
					<NumberCard title="Workspaces" :loading="loading" :value="privateTotals?.workspaces ?? null" :format="count" />
					<NumberCard title="Documents ready" :loading="loading" :value="privateTotals?.documents.ready ?? null" :format="count" />
					<NumberCard title="Documents failed" :loading="loading" :value="privateTotals?.documents.failed ?? null" :format="count" />
					<NumberCard title="Cost to index" :loading="loading" :value="privateTotals?.costUsd ?? null" :format="money" />
				</div>

				<div v-if="privateTotals?.errors.length" class="space-y-1 pt-5" data-slot="private-errors">
					<h3 class="text-base-medium text-ink-gray-8">Why documents failed</h3>
					<List :columns="['minmax(0,1fr)', '7rem']" class="-mx-3 list-row-px-3">
						<ListRows :items="privateTotals.errors" row-key="error" v-slot="{ item }">
							<ListRow class="min-h-11 py-2">
								<ListCell><span class="break-words text-sm text-ink-gray-8">{{ item.error }}</span></ListCell>
								<ListCell class="justify-end text-sm tabular-nums text-ink-gray-6">{{ documentCount(item.documents) }}</ListCell>
							</ListRow>
						</ListRows>
					</List>
				</div>
			</section>
		</template>

		<PrivacyNote>Admins see private workspaces as totals, never their names, documents or chats.</PrivacyNote>
	</div>

	<DocumentLogDialog v-model:open="logOpen" :workspace-id="logOf?.workspaceId ?? ''" :document="logDocument" />
</template>
