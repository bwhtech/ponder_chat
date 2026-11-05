<script setup lang="ts">
import { BottomSheet, Button, Dialog, Sidebar, SidebarHeader, SidebarItem, Skeleton } from "frappe-ui";
import { ref } from "vue";
import { me, refreshCredits, signOut } from "./account";
import ChatView from "./ChatView.vue";
import ColorSchemeSwitcher from "./ColorSchemeSwitcher.vue";
import CreditMeter from "./CreditMeter.vue";
import MemoryView from "./MemoryView.vue";
import ThreadList from "./ThreadList.vue";
import ThreadSkeleton from "./ThreadSkeleton.vue";
import { useThreads } from "./threads";

/** The signed-in shell: chats in a sidebar (a bottom sheet on phones) and the open chat, or the Memory page. */
const { current, currentThread, messages, running, loading, revision, refresh, open, start } = useThreads();
const sheetOpen = ref(false);
const settingsOpen = ref(false);
// The main area shows the open chat, or the Memory page (?view=memory).
const view = ref<"chat" | "memory">(viewInUrl());
addEventListener("popstate", () => (view.value = viewInUrl()));

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

function showSettings() {
	sheetOpen.value = false;
	settingsOpen.value = true;
}

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
				<SidebarHeader title="Ponder Chat" logo="/logo.png" />
				<div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
					<ThreadList @select="pick" />
				</div>
				<!-- The main action, under the list: always in the same place, however long the list grows. -->
				<div class="px-2 pb-3">
					<Button variant="solid" size="md" icon-left="lucide-square-pen" class="w-full" @click="newThread">New chat</Button>
				</div>
				<div class="border-t border-outline-gray-1 px-2 pt-2">
					<CreditMeter v-if="me" :credits="me.credits" />
					<SidebarItem label="Memory" icon="lucide-brain" :active="view === 'memory'" @click="showMemory" />
					<SidebarItem label="Settings" icon="lucide-settings" @click="showSettings" />
				</div>
				<div class="px-2 pb-3 pt-1">
					<ColorSchemeSwitcher class="w-full" fluid />
				</div>
			</Sidebar>

			<div class="flex min-w-0 flex-1 flex-col">
				<header class="flex min-h-12 shrink-0 items-center gap-2 border-b border-outline-gray-1 px-3 sm:px-5">
					<Button class="md:hidden" variant="ghost" icon="lucide-panel-left" aria-label="Chats" @click="sheetOpen = true" />
					<div v-if="loading && !currentThread" class="min-w-0 flex-1"><Skeleton class="h-4 w-48 max-w-full rounded-4" /></div>
					<h1 v-else class="min-w-0 flex-1 truncate text-base-semibold text-ink-gray-9">{{ view === "memory" ? "Memory" : (currentThread?.title ?? "New chat") }}</h1>
					<Button class="md:hidden" variant="ghost" icon="lucide-square-pen" aria-label="New chat" @click="newThread" />
				</header>
				<MemoryView v-if="view === 'memory'" @open-thread="pick" />
				<ThreadSkeleton v-else-if="loading" />
				<ChatView
					v-else-if="current"
					:key="`${current}:${revision}`"
					:thread-id="current"
					:initial-messages="messages"
					:running="running"
					@saved="onSaved"
					@refused="refreshCredits"
					@open-memory="showMemory"
				/>
			</div>
		</div>

		<BottomSheet v-model:open="sheetOpen" title="Chats">
			<div class="flex flex-col gap-2 px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
				<Button variant="solid" size="md" icon-left="lucide-square-pen" class="w-full" @click="newThread">New chat</Button>
				<ThreadList @select="pick" />
				<div class="border-t border-outline-gray-1 pt-2">
					<CreditMeter v-if="me" :credits="me.credits" />
					<SidebarItem label="Memory" icon="lucide-brain" :active="view === 'memory'" @click="showMemory" />
					<SidebarItem label="Settings" icon="lucide-settings" @click="showSettings" />
				</div>
				<ColorSchemeSwitcher fluid />
			</div>
		</BottomSheet>

		<Dialog v-model:open="settingsOpen" title="Settings" size="md">
			<div class="flex flex-col gap-6" data-slot="settings">
				<section class="flex items-center justify-between gap-3">
					<div class="min-w-0">
						<p class="text-p-sm text-ink-gray-5">Signed in as</p>
						<p class="truncate text-base text-ink-gray-9">{{ me?.user.email }}</p>
					</div>
					<Button icon-left="lucide-log-out" @click="signOut">Sign out</Button>
				</section>
				<section v-if="me" class="flex flex-col gap-1 border-t border-outline-gray-1 pt-5">
					<h3 class="text-base-semibold text-ink-gray-9">Daily credits</h3>
					<p class="text-p-sm text-ink-gray-6">
						You get {{ me.credits.limit }} credits a day. Each reply uses credits by what the model charges for it, so
						bigger models use more. Credits refill at midnight UTC.
					</p>
				</section>
			</div>
		</Dialog>
	</div>
</template>
