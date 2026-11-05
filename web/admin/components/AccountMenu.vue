<script setup lang="ts">
import { Avatar, Dropdown } from "frappe-ui";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { signOut } from "../../account";
import { useThemeMenu } from "../../theme-menu";
import { isMobile } from "../lib/viewport";
import { settingsOpen, viewer } from "../store";

/** Settings, back to chat, theme and sign out. `compact` is the avatar for a mobile header. */
defineProps<{ compact?: boolean }>();

const me = computed(() => viewer.value?.user.name || viewer.value?.user.email.split("@")[0] || "");
const router = useRouter();
const theme = useThemeMenu();

const menu = computed(() => [
	{ label: "Settings", icon: "lucide-settings", onClick: () => (isMobile.value ? void router.push("/settings") : (settingsOpen.value = true)) },
	{ label: "Back to chat", icon: "lucide-message-circle", onClick: () => location.assign("/") },
	theme(),
	{ label: "Sign out", icon: "lucide-log-out", onClick: () => void signOut() },
]);
</script>

<template>
	<Dropdown :options="menu">
		<button v-if="compact" class="rounded-full p-1" :aria-label="`Account menu, ${me}`">
			<Avatar :label="me" size="md" />
		</button>
		<button v-else class="flex w-full items-center gap-2 rounded-4 px-2 py-1.5 text-left hover:bg-surface-gray-2">
			<span class="flex size-7 items-center justify-center rounded-3 bg-surface-gray-9 text-ink-base">
				<span class="lucide-message-circle size-4" aria-hidden="true" />
			</span>
			<span class="min-w-0 flex-1">
				<span class="block truncate text-base-semibold text-ink-gray-9">Ponder Admin</span>
				<span class="block truncate text-xs text-ink-gray-5">{{ me }}</span>
			</span>
			<span class="lucide-chevrons-up-down size-4 text-ink-gray-5" aria-hidden="true" />
		</button>
	</Dropdown>
</template>
