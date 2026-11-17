<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { toast } from "./toasts";
import { provideFileViewer } from "frappe-ui-ai-elements";
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { me, refreshCredits, signOut } from "./account";
import { openSettings, settings, type SettingsTab } from "./settings/state";
import ChatView from "./ChatView.vue";
import { pendingDialog } from "./dialogs";
import ThreadSkeleton from "./ThreadSkeleton.vue";
import { modelMenuAsked } from "./models";
import { once } from "./once";
import SidebarPlaceholder from "./SidebarPlaceholder.vue";
import { afterLoad, prefetchChat } from "./preload";
import { closePanel, panelItem, viewInPanel } from "./side-panel/panel";
import { useThemeMenu } from "./theme-menu";
import { useThreads } from "./threads";
import { openWorkspaceDialog, workspaceDialogUsed } from "./workspaces/dialogs";
import { handOver, type FirstMessage } from "./workspaces/first-message";
import { openWorkspaceId, showWorkspace, workspaceInUrl } from "./workspaces/store";
import WorkspacePlaceholder from "./workspaces/WorkspacePlaceholder.vue";

/**
 * The signed-in shell: workspaces and chats in a sidebar (a bottom sheet on phones), and the
 * open chat, the Memory page or a workspace. The header at the top of the sidebar opens the
 * account menu, as on /admin.
 */
const { current, currentThread, currentWorkspace, messages, running, failed, loading, revision, refresh, open, resume, start } = useThreads();
// What answers a tap at once while the code it opens loads (stand-ins.ts): one small chunk,
// fetched once the page has drawn.
const loadStandIns = once(() => import("./stand-ins"));
const standIn = <K extends keyof Awaited<ReturnType<typeof loadStandIns>>>(name: K) => defineAsyncComponent(() => loadStandIns().then((module) => module[name]));
const SettingsPlaceholder = standIn("SettingsPlaceholder");
const MemoryPlaceholder = standIn("MemoryPlaceholder");
const PanelPlaceholder = standIn("PanelPlaceholder");
const DialogPlaceholder = standIn("DialogPlaceholder");
const PageOpening = standIn("PageOpening");
const WorkspaceDialogPlaceholder = standIn("WorkspaceDialogPlaceholder");
onMounted(() => void loadStandIns().catch(() => undefined));
// What the first page does not show loads when it opens: Settings, Memory and the side panel.
// Until each is here, its stand-in in its shape answers the tap. The overlays wait 100ms
// first, so a quick load never flashes one; Memory takes the page at once.
const SettingsModal = defineAsyncComponent({ loader: () => import("./settings/SettingsModal.vue"), loadingComponent: SettingsPlaceholder, delay: 100 });
const MemoryView = defineAsyncComponent({ loader: () => import("./MemoryView.vue"), loadingComponent: MemoryPlaceholder, delay: 0 });
const SidePanel = defineAsyncComponent({ loader: () => import("./side-panel/SidePanel.vue"), loadingComponent: PanelPlaceholder, delay: 100 });
// A workspace page, and the workspace dialogs (New workspace, Edit, Share), the same way.
// The page's stand-in comes with the first code: a workspace link draws its header at once.
const WorkspacePage = defineAsyncComponent({ loader: () => import("./workspaces/WorkspacePage.vue"), loadingComponent: WorkspacePlaceholder, delay: 0 });
const WorkspaceDialogs = defineAsyncComponent({ loader: () => import("./workspaces/WorkspaceDialogs.vue"), loadingComponent: WorkspaceDialogPlaceholder, delay: 100 });
// Each stays once it has opened, so it can play its closing transition.
const settingsUsed = ref(false);
const panelUsed = ref(false);
watch(() => settings.open, (open) => open && (settingsUsed.value = true), { immediate: true });
watch(panelItem, (item) => item && (panelUsed.value = true), { immediate: true });
// Settings' own shortcut, Cmd+Shift+, (Ctrl+Shift+,), lives in its dialog. Until the dialog has loaded, this opens it.
function settingsShortcut(event: KeyboardEvent) {
	if (settingsUsed.value || !(event.metaKey || event.ctrlKey) || !event.shiftKey || event.code !== "Comma") return;
	event.preventDefault();
	openSettings();
}
addEventListener("keydown", settingsShortcut);
onBeforeUnmount(() => removeEventListener("keydown", settingsShortcut));
// The chat's own code for replies (the AI SDK, and the Markdown, maths and code renderers)
// downloads once the page has loaded, its font and pictures too, so it never slows the first
// screen. It runs when typing a message or pointing at a chat (preload.ts).
onMounted(() => afterLoad(prefetchChat));
// Tailwind's md: the sidebar shows from here; below it, the bottom sheet.
const wideScreen = matchMedia("(min-width: 768px)");
const wide = ref(wideScreen.matches);
const onWidth = () => (wide.value = wideScreen.matches);
wideScreen.addEventListener("change", onWidth);
onBeforeUnmount(() => wideScreen.removeEventListener("change", onWidth));
// The chats (ChatsPanel.vue), their own chunk. A wide screen fetches it beside the first code
// (boot-page.ts). Until it is here, the sidebar or the sheet shows its layout with skeleton rows
// (SidebarPlaceholder.vue), so nothing moves.
const loadChatsPanel = once(() => import("./ChatsPanel.vue").then((module) => module.default));
const ChatsPanel = defineAsyncComponent({ loader: loadChatsPanel, loadingComponent: SidebarPlaceholder, delay: 0 });
// On a phone: a bottom sheet, loaded the first time it opens, or once the page has loaded on a narrow screen.
const loadBottomSheet = once(() => import("./bottom-sheet").then((module) => module.BottomSheet));
const BottomSheet = defineAsyncComponent(loadBottomSheet);
const sheetOpen = ref(false);
const sheetUsed = ref(false);
watch(sheetOpen, (open) => open && (sheetUsed.value = true));
onMounted(() => afterLoad(() => !wide.value && void Promise.all([loadBottomSheet(), loadChatsPanel()]).catch(() => undefined)));
// A request for more credits that waits for an answer: the page checks on it (CreditRequestWatch.vue,
// loaded then). It stays once mounted, to say when the answer comes.
const CreditRequestWatch = defineAsyncComponent(() => import("./CreditRequestWatch.vue"));
const requestWaited = ref(false);
watch(() => me.value?.credits.request?.status === "pending", (pending) => pending && (requestWaited.value = true), { immediate: true });
// Files in the chat (attachments, images from Python) open in the side panel.
provideFileViewer(viewInPanel);
// The main area shows the open chat, the Memory page (?view=memory), or a workspace (?w=<id>, workspaces/store.ts).
const view = ref<"chat" | "memory">(viewInUrl());
addEventListener("popstate", () => {
	view.value = viewInUrl();
	openWorkspaceId.value = workspaceInUrl();
});
const page = computed(() => (view.value === "memory" ? "memory" : openWorkspaceId.value ? "workspace" : "chat"));
// The side panel shows a file or an artifact of the open chat, so it closes when the chat changes.
watch([current, page], closePanel);
// Back to the chat from Memory or a workspace, by a click or by Back: its chat mounts again,
// with the messages it has now, not the ones it opened with. Before the render, so it never
// draws the older ones.
watch(page, (now, before) => now === "chat" && before !== "chat" && resume());
// A tap on the model button before its menu's code came (models.ts) is for that chat only.
watch(current, () => (modelMenuAsked.value = false));

function viewInUrl() {
	return new URL(location.href).searchParams.get("view") === "memory" ? "memory" : "chat";
}

function showChat() {
	if (view.value === "chat") return;
	view.value = "chat";
	const url = new URL(location.href);
	url.searchParams.delete("view");
	history.replaceState(null, "", url);
}

function showMemory() {
	sheetOpen.value = false;
	if (view.value === "memory") return;
	view.value = "memory";
	openWorkspaceId.value = "";
	const url = new URL(location.href);
	url.searchParams.delete("w");
	url.searchParams.set("view", "memory");
	history.pushState(null, "", url);
}

function pickWorkspace(id: string) {
	sheetOpen.value = false;
	view.value = "chat";
	showWorkspace(id);
}

function newWorkspace() {
	sheetOpen.value = false;
	openWorkspaceDialog({ kind: "new", onMade: pickWorkspace });
}

/** A question on a workspace page: a new chat in that workspace, which sends it at once (first-message.ts). */
function askInWorkspace(message: FirstMessage) {
	newThread();
	handOver(current.value, message);
}

function pick(id: string) {
	sheetOpen.value = false;
	showChat();
	void open(id);
}

function showSettings(tab: SettingsTab = "account") {
	sheetOpen.value = false;
	openSettings(tab);
}

// Back from a connector's sign-in in this tab (a phone): /?settings=connectors&connector=<id>,
// or &connector_error=<why> (server/mcp/routes.ts). Opens the connector, then tidies the URL.
const back = new URL(location.href);
if (back.searchParams.get("settings") === "connectors") {
	const id = back.searchParams.get("connector");
	const problem = back.searchParams.get("connector_error");
	for (const key of ["settings", "connector", "connector_error"]) back.searchParams.delete(key);
	history.replaceState(null, "", back);
	openSettings("connectors", id);
	if (problem) toast.error(problem);
	else if (id) void import("./connectors/api").then(({ loadConnectors }) => loadConnectors()).then(() => toast.success("Connected"));
}

// Admin is its own page, which on a phone on a slow network takes seconds to start drawing. The
// tap closes the menu and says so at once (PageOpening.vue), on the click, not on the touch: on an
// iPhone, what a touch adds to the page can lose its click. Back from /admin out of the browser's
// cache (bfcache), the page is as it was left, so the note goes.
// If the person stops the navigation (Escape, the Stop button), the note goes too: the Navigation
// API says so where it exists, and after OPENING_MAX_MS the note goes anyway.
const openingAdmin = ref(false);
const OPENING_MAX_MS = 20_000;
function openAdmin() {
	sheetOpen.value = false;
	openingAdmin.value = true;
	const stop = () => (openingAdmin.value = false);
	(window as { navigation?: EventTarget }).navigation?.addEventListener("navigateerror", stop, { once: true });
	setTimeout(stop, OPENING_MAX_MS);
	location.assign("/admin");
}
const backFromCache = (event: PageTransitionEvent) => event.persisted && (openingAdmin.value = false);
addEventListener("pageshow", backFromCache);
onBeforeUnmount(() => removeEventListener("pageshow", backFromCache));

// Memory, Admin (for admins), Settings, Theme and Sign out.
const theme = useThemeMenu();
const menu = computed(() => [
	{ label: "Memory", icon: "lucide-brain", onClick: showMemory },
	...(me.value?.user.role === "admin" ? [{ label: "Admin", icon: "lucide-shield", onClick: openAdmin }] : []),
	{ label: "Connectors", icon: "lucide-plug", onClick: () => showSettings("connectors") },
	{ label: "Settings", icon: "lucide-settings", onClick: () => showSettings() },
	theme(),
	{ label: "Sign out", icon: "lucide-log-out", onClick: () => void signOut() },
]);
/** People have no name until they set one, so the start of the email stands in. */
const name = computed(() => me.value?.user.name.trim() || me.value?.user.email.split("@")[0] || "");

function newThread() {
	sheetOpen.value = false;
	showChat();
	start();
}

/** A reply finished: its place in the list and the credits left may have changed. */
function onSaved() {
	void refresh();
	void refreshCredits();
}
</script>

<template>
	<div class="contents">
		<div class="flex h-dvh bg-surface-base pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-ink-gray-8">
			<!-- Phones get the chats in the bottom sheet, so there the sidebar is not drawn at all, not only hidden. -->
			<ChatsPanel
				v-if="wide"
				:name="name"
				:menu="menu"
				:highlight="page === 'chat'"
				:highlight-workspace="page === 'workspace'"
				@select="pick"
				@new-chat="newThread"
				@select-workspace="pickWorkspace"
				@new-workspace="newWorkspace"
			/>

			<!-- The page's main landmark, as on the sign-in page: the open chat, Memory or a workspace. -->
			<main class="flex min-w-0 flex-1 flex-col" data-slot="chat-column">
				<!-- A workspace draws its own header, wider, for its side panel. -->
				<WorkspacePage v-if="page === 'workspace'" :id="openWorkspaceId" :key="openWorkspaceId" @open-chat="pick" @ask="askInWorkspace" @deleted="newThread">
					<template #start><Button class="-ml-1.5 md:hidden relative after:absolute after:-inset-2 after:content-['']" variant="ghost" icon="lucide-panel-left" aria-label="Chats" @click="sheetOpen = true" /></template>
					<template #end><Button class="-mr-1.5 md:hidden relative after:absolute after:-inset-2 after:content-['']" variant="ghost" icon="lucide-square-pen" aria-label="New chat" @click="newThread" /></template>
				</WorkspacePage>
				<template v-else>
					<!-- The title sits in the same 720px column as the chat and Memory, so it shares their leading edge.
					     On phones the icon buttons pull out by their inner padding, so their glyphs sit on that edge too. -->
					<header data-slot="chat-header" class="flex min-h-12 shrink-0 border-b border-outline-gray-1">
						<div class="scroll-gutter-match flex items-center gap-2">
							<Button class="-ml-1.5 md:hidden relative after:absolute after:-inset-2 after:content-['']" variant="ghost" icon="lucide-panel-left" aria-label="Chats" @click="sheetOpen = true" />
							<div v-if="loading && !currentThread" class="flex h-[1lh] min-w-0 flex-1 items-center text-lg-semibold"><Skeleton class="h-4 w-48 max-w-full rounded-4" /></div>
							<h1 v-else class="min-w-0 flex-1 truncate text-lg-semibold text-ink-gray-9" :class="{ 'md:sr-only': view === 'chat' && !currentThread }">{{ view === "memory" ? "Memory" : (currentThread?.title ?? "New chat") }}</h1>
							<Button class="-mr-1.5 md:hidden relative after:absolute after:-inset-2 after:content-['']" variant="ghost" icon="lucide-square-pen" aria-label="New chat" @click="newThread" />
						</div>
					</header>
					<MemoryView v-if="view === 'memory'" @open-thread="pick" />
					<ThreadSkeleton v-else-if="loading" />
					<ChatView
						v-else-if="current"
						:key="`${current}:${revision}`"
						:thread-id="current"
						:initial-messages="messages"
						:running="running"
						:failed="failed"
						:workspace-id="currentWorkspace"
						@saved="onSaved"
						@refused="refreshCredits"
						@open-memory="showMemory"
					/>
				</template>
			</main>

			<SidePanel v-if="panelUsed" />
		</div>

		<BottomSheet v-if="sheetUsed" v-model:open="sheetOpen" title="Chats">
			<ChatsPanel
				sheet
				:name="name"
				:menu="menu"
				:highlight="page === 'chat'"
				:highlight-workspace="page === 'workspace'"
				@select="pick"
				@new-chat="newThread"
				@select-workspace="pickWorkspace"
				@new-workspace="newWorkspace"
			/>
		</BottomSheet>

		<SettingsModal v-if="settingsUsed" />
		<WorkspaceDialogs v-if="workspaceDialogUsed" />
		<CreditRequestWatch v-if="requestWaited" />
		<DialogPlaceholder v-if="pendingDialog" :request="pendingDialog" />
		<PageOpening v-if="openingAdmin" label="Opening admin…" />
	</div>
</template>
