<script setup lang="ts">
import { BottomSheet, Button, Sidebar, SidebarHeader, Skeleton, toast } from "frappe-ui";
import { provideFileViewer } from "frappe-ui-ai-elements";
import { computed, ref, watch } from "vue";
import { me, refreshCredits, signOut } from "./account";
import { loadConnectors } from "./connectors/api";
import SettingsModal from "./settings/SettingsModal.vue";
import { openSettings, type SettingsTab } from "./settings/state";
import ChatView from "./ChatView.vue";
import CreditMeter from "./CreditMeter.vue";
import { useCreditRequestWatch } from "./credit-request";
import MemoryView from "./MemoryView.vue";
import ThreadList from "./ThreadList.vue";
import ThreadSkeleton from "./ThreadSkeleton.vue";
import { closePanel, viewInPanel } from "./side-panel/panel";
import SidePanel from "./side-panel/SidePanel.vue";
import { useThemeMenu } from "./theme-menu";
import { useThreads } from "./threads";

/**
 * The signed-in shell: chats in a sidebar (a bottom sheet on phones) and the open chat, or
 * the Memory page. The header at the top of the sidebar opens the account menu, as on /admin.
 */
const { current, currentThread, messages, running, failed, loading, revision, refresh, open, start } = useThreads();
const sheetOpen = ref(false);
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
			<Sidebar class="hidden border-r border-outline-gray-1 md:flex" width="16rem" :collapsible="false" aria-label="Chats">
				<SidebarHeader title="Ponder Chat" :subtitle="name" logo="/logo.png" :menu-items="menu" />
				<div class="flex min-h-0 flex-1 flex-col px-2">
					<ThreadList scroll :highlight="view === 'chat'" @select="pick" />
				</div>
				<!-- The main action, under the list: always in the same place, however long the list grows.
				     Its content starts on the sidebar's edges, like the search field: icon at 16px, label at 40px. -->
				<div class="px-2 pb-3 pt-3">
					<Button variant="outline" size="md" icon-left="lucide-square-pen" class="w-full !justify-start !px-2 bg-surface-base transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out-strong active:scale-[0.98] motion-reduce:transform-none" @click="newThread">New chat</Button>
				</div>
				<div v-if="me" class="px-2 pb-2">
					<CreditMeter :credits="me.credits" />
				</div>
			</Sidebar>

			<div class="flex min-w-0 flex-1 flex-col" data-slot="chat-column">
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
			</div>

			<SidePanel />
		</div>

		<BottomSheet v-model:open="sheetOpen" title="Chats">
			<div class="flex flex-col gap-2 px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
				<SidebarHeader title="Ponder Chat" :subtitle="name" logo="/logo.png" :menu-items="menu" class="-mx-1 -mt-2" />
				<Button variant="outline" size="md" icon-left="lucide-square-pen" class="w-full !justify-start !px-2 bg-surface-base" @click="newThread">New chat</Button>
				<ThreadList :highlight="view === 'chat'" @select="pick" />
				<div v-if="me" class="border-t border-outline-gray-1 pt-2">
					<CreditMeter :credits="me.credits" />
				</div>
			</div>
		</BottomSheet>

		<SettingsModal />
	</div>
</template>
