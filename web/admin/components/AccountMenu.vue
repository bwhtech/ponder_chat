<script setup lang="ts">
import { Avatar, Dropdown, useColorScheme } from "frappe-ui";
import { computed, h } from "vue";
import { useRouter } from "vue-router";
import { signOut } from "../../account";
import { isMobile } from "../lib/viewport";
import { settingsOpen, viewer } from "../store";

/** Settings, back to chat, theme and sign out. `compact` is the avatar for a mobile header. */
defineProps<{ compact?: boolean }>();

const me = computed(() => viewer.value?.user.name || viewer.value?.user.email.split("@")[0] || "");
const { colorScheme, setColorScheme } = useColorScheme();
const router = useRouter();
const themes = [
	{ label: "Light", value: "light", icon: "lucide-sun" },
	{ label: "Dark", value: "dark", icon: "lucide-moon" },
	{ label: "System", value: "system", icon: "lucide-monitor" },
] as const;

const menu = computed(() => [
	{ label: "Settings", icon: "lucide-settings", onClick: () => (isMobile.value ? void router.push("/settings") : (settingsOpen.value = true)) },
	{ label: "Back to chat", icon: "lucide-message-circle", onClick: () => location.assign("/") },
	{
		label: "Theme",
		icon: "lucide-sun-moon",
		submenu: themes.map((t) => ({
			label: t.label,
			icon: t.icon,
			selected: colorScheme.value === t.value,
			slots: {
				suffix: ({ selected }: { selected: boolean }) => (selected ? h("span", { class: "lucide-check size-4 shrink-0 text-ink-gray-7" }) : null),
			},
			onClick: () => setColorScheme(t.value),
		})),
	},
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
