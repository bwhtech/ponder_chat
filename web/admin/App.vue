<script setup lang="ts">
import {
	Badge,
	Button,
	DesktopShell,
	FrappeUIProvider,
	MobileNav,
	MobileNavItem,
	MobileShell,
	ScrollArea,
	Sidebar,
	SidebarItem,
	SidebarSection,
} from "frappe-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterView, useRoute } from "vue-router";
import { loadViewer } from "./api";
import AccountMenu from "./components/AccountMenu.vue";
import NoAccess from "./components/NoAccess.vue";
import SettingsModal from "./components/SettingsModal.vue";
import { isMobile } from "./lib/viewport";
import { counts, refreshCounts, settingsOpen, viewer } from "./store";
import EmptyState from "../EmptyState.vue";

/**
 * The admin shell. Signed out goes to the chat's sign-in page. Signed in without the
 * admin role sees NoAccess. The server checks the role again on every /api/admin call.
 * Settings is a dialog on wider screens (account menu) and a tab on phones.
 */
const route = useRoute();
const isAdmin = computed(() => viewer.value?.user.role === "admin");

// Offline or a failing server is not "signed out": say so, with Retry, and ask again when back online.
const viewerError = ref(false);
async function askViewer() {
	try {
		const loaded = await loadViewer();
		if (!loaded) return location.assign("/");
		viewer.value = loaded;
		viewerError.value = false;
	} catch {
		viewerError.value = true;
	}
}
void askViewer();
const retryViewer = () => viewer.value === undefined && void askViewer();
addEventListener("online", retryViewer);
onBeforeUnmount(() => removeEventListener("online", retryViewer));

// The sidebar's counts: on each page change, and every minute for requests that come in.
watch([isAdmin, () => route.path], ([admin]) => admin && void refreshCounts(), { immediate: true });
const timer = setInterval(() => isAdmin.value && void refreshCounts(), 60_000);
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
	<FrappeUIProvider>
		<div class="h-dvh w-full bg-surface-base text-ink-gray-8">
			<EmptyState v-if="!viewer && viewerError" icon="lucide-wifi-off" title="Can't reach Ponder" body="Check your connection, then try again." alert class="h-full">
				<Button label="Try again" @click="retryViewer" />
			</EmptyState>
			<div v-else-if="!viewer" class="h-full" aria-busy="true" />
			<NoAccess v-else-if="!isAdmin" :email="viewer.user.email" />

			<MobileShell v-else-if="isMobile">
				<RouterView />
				<template #nav>
					<MobileNav>
						<MobileNavItem label="Overview" icon="lucide-chart-column" route="/" :active="route.path === '/'" />
						<MobileNavItem label="Requests" icon="lucide-inbox" route="/requests" :active="route.path === '/requests'">
							<template #default="{ active }">
								<span class="relative">
									<span class="lucide-inbox block size-6" :class="active ? 'text-ink-gray-8' : 'text-ink-gray-5'" aria-hidden="true" />
									<Badge
										v-if="counts.pendingRequests"
										theme="amber"
										variant="solid"
										size="sm"
										:label="String(counts.pendingRequests)"
										class="absolute -right-3 -top-1.5"
									/>
								</span>
							</template>
						</MobileNavItem>
						<MobileNavItem label="People" icon="lucide-users" route="/people" :active="route.path.startsWith('/people')" />
						<MobileNavItem label="Skills" icon="lucide-sparkles" route="/skills" :active="route.path.startsWith('/skills')" />
						<MobileNavItem label="Settings" icon="lucide-settings" route="/settings" :active="route.path === '/settings'" />
					</MobileNav>
				</template>
			</MobileShell>

			<DesktopShell v-else>
				<template #sidebar>
					<Sidebar width="16rem" class="border-r">
						<AccountMenu />
						<ScrollArea class="min-h-0 flex-1" viewport-class="px-2 pt-1 pb-10">
							<SidebarSection>
								<div class="space-y-0.5">
									<SidebarItem class="!h-7 [@media(pointer:coarse)]:!h-11" label="Overview" icon="lucide-chart-column" route="/" />
									<SidebarItem class="!h-7 [@media(pointer:coarse)]:!h-11" label="Requests" icon="lucide-inbox" route="/requests">
										<template #suffix>
											<Badge
												v-if="counts.pendingRequests"
												theme="amber"
												variant="solid"
												size="sm"
												:label="String(counts.pendingRequests)"
												:aria-label="`${counts.pendingRequests} waiting`"
												class="mr-1.5"
											/>
										</template>
									</SidebarItem>
									<SidebarItem class="!h-7 [@media(pointer:coarse)]:!h-11" label="People" icon="lucide-users" route="/people" :active="route.path.startsWith('/people')">
										<template #suffix>
											<span v-if="counts.invited" class="mr-2 text-xs tabular-nums text-ink-gray-5">{{ counts.invited }} invited</span>
										</template>
									</SidebarItem>
									<SidebarItem class="!h-7 [@media(pointer:coarse)]:!h-11" label="Skills" icon="lucide-sparkles" route="/skills" :active="route.path.startsWith('/skills')" />
									<SidebarItem class="!h-7 [@media(pointer:coarse)]:!h-11" label="Activity" icon="lucide-history" route="/activity" :active="route.path === '/activity'" />
								</div>
							</SidebarSection>
						</ScrollArea>
						<div class="px-2 py-2">
							<SidebarItem class="!h-7 [@media(pointer:coarse)]:!h-11" label="Back to chat" icon="lucide-arrow-left" href="/" />
						</div>
					</Sidebar>
				</template>
				<RouterView />
				<SettingsModal v-model:open="settingsOpen" />
			</DesktopShell>
		</div>
	</FrappeUIProvider>
</template>
