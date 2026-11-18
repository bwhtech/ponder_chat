<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { ApiError } from "../api";
import { dialog } from "../dialogs";
import EmptyState from "../EmptyState.vue";
import { panelItem } from "../side-panel/panel";
import { toast } from "../toasts";
import { useThreads, useWorkspaceThreads } from "../threads";
import { openWorkspaceDialog } from "./dialogs";
import type { WorkspaceDocument } from "./documents";
import type { FirstMessage } from "./first-message";
import type { ComposerHandle } from "./handles";
import { Poller } from "./poller";
import WorkspaceAside from "./WorkspaceAside.vue";
import WorkspaceChats from "./WorkspaceChats.vue";
import WorkspaceComposer from "./WorkspaceComposer.vue";
import WorkspaceHeading from "./WorkspaceHeading.vue";
import WorkspaceOnboarding from "./WorkspaceOnboarding.vue";
import { deleteWorkspace, fetchWorkspace, loadWorkspaces, replaceWorkspaceKey, takeMadeWorkspace, updateWorkspace, workspaceByKey, type WorkspaceDetail } from "./store";

/**
 * A workspace (`?w=<slug>`): its name, the person's own chats in it, a side panel with the
 * instructions, the documents and its people (under the chats on a phone), and the composer,
 * whose new chat is in this workspace, at the bottom, where the chat's own box will be. The sidebar's row draws the header
 * at once; the rest fills in when the workspace loads. A workspace the person cannot use is
 * not found. An older link by the workspace's id opens it too, and the slug takes its place.
 * While the person has no chat here, setup steps or first questions take the chats' place
 * (WorkspaceOnboarding.vue). A workspace just made in this tab shows at once, with them.
 *
 * It renders its own header, as the main area's first child, so the hairline under it follows
 * this page's scroller (style.css).
 */
const props = defineProps<{ slugOrId: string }>();
const emit = defineEmits<{ openChat: [id: string]; ask: [message: FirstMessage]; deleted: []; newChat: [] }>();

const { refresh: refreshThreads } = useThreads();
const detail = shallowRef<WorkspaceDetail>();
const missing = ref(false);
const loadError = ref("");
/** What the page shows before the workspace loads: the sidebar's row. */
const summary = computed(() => detail.value ?? workspaceByKey(props.slugOrId));
const workspaceId = computed(() => summary.value?.id ?? "");
const { chats, loaded: chatsLoaded } = useWorkspaceThreads(() => workspaceId.value);
/** A workspace made in this tab has no chats: its page need not wait for the list to say so. */
const madeHere = ref("");
/** No chat of the person's here, for sure: the setup steps or first questions show in the chats' place. */
const onboarding = computed(() => Boolean(detail.value && !chats.value.length && (chatsLoaded.value || madeHere.value === detail.value.id)));
const composer = ref<ComposerHandle>();
/** The chats beside the side panel, from Tailwind's lg; one column under them while the file viewer is open beside the page. */
const columns = computed(() => (panelItem.value ? "" : "lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-12"));

/**
 * What Tab reaches scrolls clear of the message box: the page keeps scroll padding at the
 * bottom as tall as the box's row and its fade (40px). The box grows with its text, files and
 * the credits alert, so the padding follows its height.
 */
const FADE_PX = 40;
const dock = ref<HTMLElement | null>(null);
const dockHeight = ref(0);
const dockObserver = new ResizeObserver(([entry]) => (dockHeight.value = entry ? Math.ceil(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height) : 0));
watch(dock, (now, before) => {
	if (before) dockObserver.unobserve(before);
	if (now) dockObserver.observe(now);
});
onBeforeUnmount(() => dockObserver.disconnect());

// Each load takes a number: the answer for a workspace no longer open is dropped.
let asked = 0;
watch(() => props.slugOrId, (key) => (detail.value?.slug === key ? undefined : load()), { immediate: true });

async function load() {
	const mine = ++asked;
	// No document is Reading now, so the polls stop (below). One made in this tab shows as it was made.
	const made = takeMadeWorkspace(props.slugOrId);
	detail.value = made;
	madeHere.value = made?.id ?? "";
	missing.value = false;
	loadError.value = "";
	try {
		const found = await fetchWorkspace(props.slugOrId);
		if (mine !== asked) return;
		detail.value = found;
		replaceWorkspaceKey(props.slugOrId, found.slug);
	} catch (error) {
		if (mine !== asked) return;
		if (error instanceof ApiError && error.status === 404) {
			missing.value = true;
			// It may have been in the sidebar: the person lost it, or it was deleted.
			void loadWorkspaces();
		} else loadError.value = (error as Error).message;
	}
}

/**
 * While a document is Indexing, the workspace is read again, a little less often each time
 * (2 s up to 10 s), until none is. While one shows its progress (a model reads its pages, or
 * its passages are embedded), the wait stays at 3 s at most, so the numbers move on the
 * row. A failed poll changes nothing on the page; the next one tries again, unless the
 * workspace is gone. An answer asked for before a change in the side panel is dropped: it
 * may not have the new document yet. One chain of polls runs at a time, and none once the
 * page is left (poller.ts).
 */
const POLL_FIRST_MS = 2000;
const POLL_MAX_MS = 10_000;
const POLL_PROGRESS_MAX_MS = 3000;
const poller = new Poller(poll);
let pollDelay = POLL_FIRST_MS;
let changes = 0;
const reading = computed(() => Boolean(detail.value?.documents.some((document: WorkspaceDocument) => document.status === "reading")));
const counting = computed(() => Boolean(detail.value?.documents.some((document: WorkspaceDocument) => document.status === "reading" && document.progress)));
watch(reading, (now) => (now ? startPolling() : poller.stop()));
onBeforeUnmount(() => poller.stop());

function startPolling() {
	pollDelay = POLL_FIRST_MS;
	poller.start(pollDelay);
}

/** Reads the workspace again; the wait before the next read, or null. */
async function poll(current: () => boolean) {
	const mine = asked;
	const seen = changes;
	try {
		const fresh = await fetchWorkspace(workspaceId.value);
		if (current() && mine === asked && seen === changes) detail.value = fresh;
	} catch (error) {
		// Deleted, or shared no more: asking again will not help. Offline for a moment: the next poll tries again.
		if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
	}
	if (!current() || mine !== asked || !reading.value) return null;
	pollDelay = Math.min(counting.value ? POLL_PROGRESS_MAX_MS : POLL_MAX_MS, pollDelay * 1.5);
	return pollDelay;
}

/** An upload, a delete or "Try again" in the side panel. */
function documentsChanged(documents: WorkspaceDocument[]) {
	if (!detail.value) return;
	changes++;
	detail.value = { ...detail.value, documents };
	// A new Reading document starts the polls again from the shortest wait.
	if (reading.value) startPolling();
}

/**
 * A new name from the title shows at once; the sidebar and a chat's breadcrumb follow once it
 * is saved. If saving fails, the old name comes back.
 */
async function rename(name: string) {
	const before = detail.value;
	if (!before) return;
	changes++;
	detail.value = { ...before, name };
	try {
		const saved = await updateWorkspace(before.id, { name });
		if (detail.value?.id === saved.id) detail.value = saved;
	} catch (error) {
		if (detail.value?.id === before.id) detail.value = { ...detail.value, name: before.name };
		toast.error((error as Error).message);
	}
}

function editInstructions() {
	if (detail.value) openWorkspaceDialog({ kind: "instructions", workspace: detail.value, onSaved: (saved) => (detail.value = saved) });
}

function share() {
	if (detail.value) openWorkspaceDialog({ kind: "share", workspace: detail.value, onSaved: (saved) => (detail.value = saved) });
}

function askDelete() {
	const workspace = detail.value;
	if (!workspace) return;
	dialog.danger({
		title: "Delete this workspace?",
		message: `“${workspace.name}”, its instructions and its documents will be deleted. Chats in it are kept.`,
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
			<WorkspaceHeading v-else-if="summary" :workspace="summary" :ready="Boolean(detail)" @rename="rename" @share="share" @delete="askDelete" />
			<div v-else class="flex h-[1lh] min-w-0 flex-1 items-center text-lg-semibold"><Skeleton class="h-4 w-48 max-w-full rounded-4" /></div>
			<slot name="end" />
		</div>
	</header>

	<div v-if="missing || loadError" class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-[1120px] px-4 sm:px-5">
			<EmptyState v-if="missing" icon="lucide-circle-alert" title="No workspace here" body="It was deleted, or it isn't shared with you.">
				<Button label="New chat" @click="emit('newChat')" />
			</EmptyState>
			<EmptyState v-else icon="lucide-circle-alert" title="This workspace could not load" :body="loadError" alert>
				<Button label="Try again" @click="load" />
			</EmptyState>
		</div>
	</div>

	<!-- The page scrolls under its message box, which floats at the bottom where a chat's box sits:
	     in the chats' column beside the side panel, across the page on a phone. The box comes first,
	     for the keyboard and screen readers, and shows last (order-last, sticky). It sits in the same
	     scroller, so the wheel scrolls the page over it, and its own row is the room the page needs
	     to scroll clear of it. -->
	<div
		v-else
		data-slot="workspace-view"
		class="scroll-fade-y scrollbar-thin min-h-0 flex-1 overflow-y-auto [--scroll-fade-size:40px] sm:[scrollbar-gutter:stable_both-edges]"
		:style="{ scrollPaddingBottom: `${dockHeight + FADE_PX}px` }"
	>
		<div class="flex min-h-full flex-col">
			<div ref="dock" class="pointer-events-none sticky bottom-0 z-10 order-last" data-slot="workspace-dock">
				<div class="mx-auto grid w-full max-w-[1120px] px-4 sm:px-5" :class="columns">
					<div class="pointer-events-auto relative min-w-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-5">
						<!-- The page's background behind the box, fading in over 40px above it, as a chat fades out above its box. -->
						<div class="pointer-events-none absolute -inset-x-4 -top-10 bottom-0 -z-10 bg-surface-base [mask-image:linear-gradient(to_bottom,transparent,#000_40px)] sm:-inset-x-5" aria-hidden="true" />
						<WorkspaceComposer :key="workspaceId" ref="composer" :workspace-id="workspaceId" :name="summary?.name ?? ''" @ask="emit('ask', $event)" />
					</div>
				</div>
			</div>
			<!-- The file viewer beside the page leaves too little width for two columns. -->
			<div class="mx-auto grid w-full max-w-[1120px] flex-1 content-start gap-8 px-4 pb-10 pt-6 sm:px-5" :class="columns">
				<WorkspaceChats v-if="chats.length" class="min-w-0" :chats="chats" :shared="Boolean(summary && (summary.kind === 'org' || summary.memberCount))" @open="emit('openChat', $event)" />
				<!-- Fades in when the workspace and its chats arrive; a workspace made here shows it at once. -->
				<Transition enter-from-class="opacity-0" enter-active-class="transition-opacity duration-200 ease-out-strong motion-reduce:transition-none">
					<div v-if="onboarding && detail" class="min-w-0">
						<WorkspaceOnboarding
							:key="detail.id"
							:workspace="detail"
							@instructions="editInstructions"
							@share="share"
							@documents="documentsChanged"
							@pick="composer?.fill($event)"
						/>
					</div>
				</Transition>
				<WorkspaceAside :class="{ 'lg:col-start-2 lg:row-start-1': !panelItem }" :workspace="summary" :detail="detail" :setup="onboarding" @instructions="editInstructions" @documents="documentsChanged" />
			</div>
		</div>
	</div>
</template>
