<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { computed, ref, shallowRef, watch } from "vue";
import { ApiError } from "../api";
import { dialog } from "../dialogs";
import EmptyState from "../EmptyState.vue";
import { toast } from "../toasts";
import { useThreads } from "../threads";
import { openWorkspaceDialog } from "./dialogs";
import type { FirstMessage } from "./first-message";
import WorkspaceAside from "./WorkspaceAside.vue";
import WorkspaceChats from "./WorkspaceChats.vue";
import WorkspaceComposer from "./WorkspaceComposer.vue";
import WorkspaceHeading from "./WorkspaceHeading.vue";
import { deleteWorkspace, fetchWorkspace, loadWorkspaces, workspaceById, type WorkspaceDetail } from "./store";

/**
 * A workspace (`?w=<id>`): its name and who can use it, the composer, whose new chat is in
 * this workspace, the person's own chats in it, and a side panel with the instructions and
 * "Shared with" (under the chats on a phone). The sidebar's row draws the header at once;
 * the rest fills in when the workspace loads. A workspace the person cannot use is not found.
 *
 * It renders its own header, as the main area's first child, so the hairline under it follows
 * this page's scroller (style.css).
 */
const props = defineProps<{ id: string }>();
const emit = defineEmits<{ openChat: [id: string]; ask: [message: FirstMessage]; deleted: [] }>();

const { refresh: refreshThreads } = useThreads();
const detail = shallowRef<WorkspaceDetail>();
const missing = ref(false);
const loadError = ref("");
/** What the page shows before the workspace loads: the sidebar's row. */
const summary = computed(() => detail.value ?? workspaceById(props.id));

// Each load takes a number: the answer for a workspace no longer open is dropped.
let asked = 0;
watch(() => props.id, load, { immediate: true });

async function load() {
	const mine = ++asked;
	detail.value = undefined;
	missing.value = false;
	loadError.value = "";
	try {
		const found = await fetchWorkspace(props.id);
		if (mine === asked) detail.value = found;
	} catch (error) {
		if (mine !== asked) return;
		if (error instanceof ApiError && error.status === 404) {
			missing.value = true;
			// It may have been in the sidebar: the person lost it, or it was deleted.
			void loadWorkspaces();
		} else loadError.value = (error as Error).message;
	}
}

function edit() {
	if (detail.value) openWorkspaceDialog({ kind: "edit", workspace: detail.value, onSaved: (saved) => (detail.value = saved) });
}

function share() {
	if (detail.value) openWorkspaceDialog({ kind: "share", workspace: detail.value, onSaved: (saved) => (detail.value = saved) });
}

function askDelete() {
	const workspace = detail.value;
	if (!workspace) return;
	dialog.danger({
		title: "Delete this workspace?",
		message: `“${workspace.name}” and its instructions will be deleted. The chats in it stay with the people who wrote them, outside any workspace.`,
		onConfirm: async () => {
			await deleteWorkspace(workspace.id);
			void refreshThreads();
			toast.success(`Deleted “${workspace.name}”`);
			emit("deleted");
		},
	});
}
</script>

<template>
	<header data-slot="chat-header" class="flex min-h-12 shrink-0 border-b border-outline-gray-1">
		<div class="workspace-gutter-match flex min-w-0 items-center gap-2">
			<slot name="start" />
			<h1 v-if="missing || loadError" class="min-w-0 flex-1 truncate text-lg-semibold text-ink-gray-9">Workspace</h1>
			<WorkspaceHeading v-else-if="summary" :workspace="summary" :ready="Boolean(detail)" @edit="edit" @share="share" @delete="askDelete" />
			<div v-else class="flex h-[1lh] min-w-0 flex-1 items-center text-lg-semibold"><Skeleton class="h-4 w-48 max-w-full rounded-4" /></div>
			<slot name="end" />
		</div>
	</header>

	<div v-if="missing || loadError" class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-[1120px] px-4 sm:px-5">
			<EmptyState v-if="missing" icon="lucide-folder-x" title="This workspace was not found" body="It may have been deleted, or you may not have access to it." />
			<EmptyState v-else icon="lucide-wifi-off" title="This workspace could not load" :body="loadError" alert>
				<Button label="Try again" @click="load" />
			</EmptyState>
		</div>
	</div>

	<div
		v-else
		data-slot="workspace-view"
		class="scroll-fade-y scrollbar-thin min-h-0 flex-1 overflow-y-auto [--scroll-fade-range:40px] [--scroll-fade-size:40px] sm:[scrollbar-gutter:stable_both-edges]"
	>
		<div class="mx-auto grid w-full max-w-[1120px] gap-8 px-4 pb-10 pt-6 sm:px-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-12">
			<div class="min-w-0 space-y-8">
				<p v-if="summary?.description" class="text-p-base text-ink-gray-6">{{ summary.description }}</p>
				<WorkspaceComposer :workspace-id="id" :name="summary?.name ?? ''" @ask="emit('ask', $event)" />
				<WorkspaceChats :workspace-id="id" @open="emit('openChat', $event)" />
			</div>
			<WorkspaceAside :workspace="summary" :detail="detail" @edit="edit" @share="share" />
		</div>
	</div>
</template>
