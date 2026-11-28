<script setup lang="ts">
import {
	Badge,
	Button,
	DesktopShell,
	Dropdown,
	FrappeUIProvider,
	MobileNav,
	MobileNavItem,
	MobileShell,
	ScrollArea,
	Sidebar,
	SidebarItem,
	SidebarSection,
} from "frappe-ui";
import { computed, defineAsyncComponent, onBeforeUnmount, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import AccountMenu from "./components/AccountMenu.vue";
import NoAccess from "./components/NoAccess.vue";
import { isMobile } from "./lib/viewport";
import { askViewer, counts, refreshCounts, scope, settingsOpen, viewer, viewerError } from "./store";
import EmptyState from "../EmptyState.vue";

/**
 * The admin shell. main.ts draws it once it knows who is signed in (store.ts). Signed in
 * without the admin role, and admin of no team, sees NoAccess. The server checks the role
 * again on every /api/admin call. Settings is a dialog on wider screens (account menu) and
 * a page under the phone tab bar's More, with Workspaces and Activity.
 *
 * A team admin's shell has only Teams, which is their first page, and a way back to the
 * chat. Any other page shows NoAccess inside the shell.
 */
const route = useRoute();
const router = useRouter();
const isAdmin = computed(() => scope.value === "org");
const isTeamAdmin = computed(() => scope.value === "team");
const inTeams = computed(() => route.path === "/teams" || route.path.startsWith("/teams/"));

// A team admin's first page is Teams. Replaced, so Back does not return to the empty "/".
watch([isTeamAdmin, () => route.path], ([team, path]) => team && path === "/" && void router.replace("/teams"), { immediate: true });

// The dialog's code loads after the first page, as it opens only from the account menu or its shortcut.
const SettingsModal = defineAsyncComponent(() => import("./components/SettingsModal.vue"));

// When /api/me could not answer, ask again on Try again and when back online.
const retryViewer = () => viewer.value === undefined && void askViewer();
addEventListener("online", retryViewer);
onBeforeUnmount(() => removeEventListener("online", retryViewer));

// Phones: the pages past the first four share the tab bar's last tab, More.
const MORE = [
	{ label: "Teams", icon: "lucide-users-round", route: "/teams" },
	{ label: "Workspaces", icon: "lucide-layers", route: "/workspaces" },
	{ label: "Activity", icon: "lucide-history", route: "/activity" },
	{ label: "Settings", icon: "lucide-settings", route: "/settings" },
];
const inMore = computed(() => MORE.some((item) => route.path === item.route || route.path.startsWith(`${item.route}/`)));

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
			<NoAccess v-else-if="!scope" :email="viewer.user.email" />

			<MobileShell v-else-if="isTeamAdmin && isMobile">
				<RouterView v-if="inTeams" />
				<NoAccess v-else-if="route.path !== '/'" :email="viewer.user.email" teams class="py-16" />
				<template #nav>
					<MobileNav>
						<MobileNavItem label="Teams" icon="lucide-users-round" route="/teams" :active="inTeams" />
						<MobileNavItem label="Chat" icon="lucide-message-circle" href="/" :active="false" />
					</MobileNav>
				</template>
			</MobileShell>

			<DesktopShell v-else-if="isTeamAdmin">
				<template #sidebar>
					<Sidebar width="16rem" class="border-r">
						<AccountMenu />
						<ScrollArea class="min-h-0 flex-1" viewport-class="px-2 pt-1 pb-10">
							<SidebarSection>
								<SidebarItem class="!h-7 [@media(pointer:coarse)]:!h-11" label="Teams" icon="lucide-users-round" route="/teams" :active="inTeams" />
							</SidebarSection>
						</ScrollArea>
						<div class="px-2 py-2">
							<SidebarItem class="!h-7 [@media(pointer:coarse)]:!h-11" label="Back to chat" icon="lucide-arrow-left" href="/" />
						</div>
					</Sidebar>
				</template>
				<RouterView v-if="inTeams" />
				<NoAccess v-else-if="route.path !== '/'" :email="viewer.user.email" teams class="py-16" />
			</DesktopShell>

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
						<MobileNavItem label="Users" icon="lucide-user-round" route="/people" :active="route.path.startsWith('/people')" />
						<MobileNavItem label="Skills" icon="lucide-sparkles" route="/skills" :active="route.path.startsWith('/skills')" />
						<Dropdown :options="MORE" side="top" align="end">
							<MobileNavItem label="More" icon="lucide-ellipsis" :active="inMore" />
						</Dropdown>
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
									<SidebarItem class="!h-7 [@media(pointer:coarse)]:!h-11" label="Users" icon="lucide-user-round" route="/people" :active="route.path.startsWith('/people')">
										<template #suffix>
											<span v-if="counts.invited" class="mr-2 text-xs tabular-nums text-ink-gray-5">{{ counts.invited }} invited</span>
										</template>
									</SidebarItem>
									<SidebarItem class="!h-7 [@media(pointer:coarse)]:!h-11" label="Teams" icon="lucide-users-round" route="/teams" :active="route.path.startsWith('/teams')" />
									<SidebarItem class="!h-7 [@media(pointer:coarse)]:!h-11" label="Skills" icon="lucide-sparkles" route="/skills" :active="route.path.startsWith('/skills')" />
									<SidebarItem class="!h-7 [@media(pointer:coarse)]:!h-11" label="Workspaces" icon="lucide-layers" route="/workspaces" :active="route.path === '/workspaces'" />
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
