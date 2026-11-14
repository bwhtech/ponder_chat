<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { toast } from "./toasts";
import { provideFileViewer } from "frappe-ui-ai-elements";
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { me, refreshCredits, signOut } from "./account";
import { loadConnectors } from "./connectors/api";
import { openSettings, settings, type SettingsTab } from "./settings/state";
import ChatView from "./ChatView.vue";
import { useCreditRequestWatch } from "./credit-request";
import ThreadSkeleton from "./ThreadSkeleton.vue";
import { once } from "./once";
import SidebarPlaceholder from "./SidebarPlaceholder.vue";
import { afterLoad, prefetchChat } from "./preload";
import { closePanel, panelItem, viewInPanel } from "./side-panel/panel";
import { useThemeMenu } from "./theme-menu";
import { useThreads } from "./threads";

/**
 * The signed-in shell: chats in a sidebar (a bottom sheet on phones) and the open chat, or
 * the Memory page. The header at the top of the sidebar opens the account menu, as on /admin.
 */
const { current, currentThread, messages, running, failed, loading, revision, refresh, open, start } = useThreads();
// What the first page does not show loads when it opens: Settings, Memory and the side panel.
const SettingsModal = defineAsyncComponent(() => import("./settings/SettingsModal.vue"));
const MemoryView = defineAsyncComponent(() => import("./MemoryView.vue"));
const SidePanel = defineAsyncComponent(() => import("./side-panel/SidePanel.vue"));
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
// (boot-page.ts) and shows a sidebar of the same size until it is here, so nothing moves.
const loadChatsPanel = once(() => import("./ChatsPanel.vue").then((module) => module.default));
const ChatsPanel = defineAsyncComponent({ loader: loadChatsPanel, loadingComponent: SidebarPlaceholder, delay: 0 });
// On a phone: a bottom sheet, loaded the first time it opens, or once the page has loaded on a narrow screen.
const loadBottomSheet = once(() => import("./bottom-sheet").then((module) => module.BottomSheet));
const BottomSheet = defineAsyncComponent(loadBottomSheet);
const sheetOpen = ref(false);
const sheetUsed = ref(false);
watch(sheetOpen, (open) => open && (sheetUsed.value = true));
onMounted(() => afterLoad(() => !wide.value && void Promise.all([loadBottomSheet(), loadChatsPanel()]).catch(() => undefined)));
// A request for more credits that waits for an answer: the page checks on it.
useCreditRequestWatch();
// Files in the chat (attachments, images from Python) open in the side panel.
provideFileViewer(viewInPanel);
// The main area shows the open chat, or the Memory page (?view=memory).
const view = ref<"chat" | "memory">(viewInUrl());
addEventListener("popstate", () => (view.value = viewInUrl()));
// The side panel shows a file or an artifact of the open chat, so it closes when the chat changes.
watch([current, view], closePanel);

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
	const url = new URL(location.href);
	url.searchParams.set("view", "memory");
	history.pushState(null, "", url);
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
	else if (id) void loadConnectors().then(() => toast.success("Connected"));
}

// Memory, Admin (for admins), Settings, Theme and Sign out.
const theme = useThemeMenu();
const menu = computed(() => [
	{ label: "Memory", icon: "lucide-brain", onClick: showMemory },
	...(me.value?.user.role === "admin" ? [{ label: "Admin", icon: "lucide-shield", onClick: () => location.assign("/admin") }] : []),
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
			<ChatsPanel v-if="wide" :name="name" :menu="menu" :highlight="view === 'chat'" @select="pick" @new-chat="newThread" />

			<!-- The page's main landmark, as on the sign-in page: the open chat or Memory. -->
			<main class="flex min-w-0 flex-1 flex-col" data-slot="chat-column">
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
					@saved="onSaved"
					@refused="refreshCredits"
					@open-memory="showMemory"
				/>
			</main>

			<SidePanel v-if="panelUsed" />
		</div>

		<BottomSheet v-if="sheetUsed" v-model:open="sheetOpen" title="Chats">
			<ChatsPanel sheet :name="name" :menu="menu" :highlight="view === 'chat'" @select="pick" @new-chat="newThread" />
		</BottomSheet>

		<SettingsModal v-if="settingsUsed" />
	</div>
</template>
