<script setup lang="ts">
import { Avatar, Dropdown, SidebarHeader } from "frappe-ui";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { signOut } from "../../account";
import BrandLogo from "../../BrandLogo.vue";
import { useThemeMenu } from "../../theme-menu";
import { isMobile } from "../lib/viewport";
import { settingsOpen, viewer } from "../store";

/** Settings, Workspaces and Activity on phones, back to chat, theme and sign out. `compact` is the avatar for a mobile header. */
defineProps<{ compact?: boolean }>();

const me = computed(() => viewer.value?.user.name || viewer.value?.user.email.split("@")[0] || "");
const router = useRouter();
const theme = useThemeMenu();

// Phones have no room for Workspaces and Activity in the tab bar, so they are here; wider screens have them in the sidebar.
const menu = computed(() => [
	{ label: "Settings", icon: "lucide-settings", onClick: () => (isMobile.value ? void router.push("/settings") : (settingsOpen.value = true)) },
	...(isMobile.value
		? [
				{ label: "Workspaces", icon: "lucide-layers", onClick: () => void router.push("/workspaces") },
				{ label: "Activity", icon: "lucide-history", onClick: () => void router.push("/activity") },
			]
		: []),
	{ label: "Back to chat", icon: "lucide-message-circle", onClick: () => location.assign("/") },
	theme(),
	{ label: "Sign out", icon: "lucide-log-out", onClick: () => void signOut() },
]);
</script>

<template>
	<Dropdown v-if="compact" :options="menu">
		<button class="rounded-full p-1" :aria-label="`Account menu, ${me}`">
			<Avatar :label="me" size="md" />
		</button>
	</Dropdown>
	<!-- The same header as the chat's sidebar, so both look like one app. -->
	<SidebarHeader v-else title="Ponder Admin" :subtitle="me" :logo="BrandLogo" :menu-items="menu" />
</template>
