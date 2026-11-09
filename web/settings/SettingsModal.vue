<script setup lang="ts">
import { Button, SettingsContent, SettingsDialog, SettingsNavGroup, SettingsNavItem, SettingsPanel, SettingsSidebar } from "frappe-ui";
import { computed, watch } from "vue";
import { connectors, connectorsError, loadConnectors } from "../connectors/api";
import ConnectorPage from "../connectors/ConnectorPage.vue";
import ConnectorsPanel from "../connectors/ConnectorsPanel.vue";
import AccountPanel from "./AccountPanel.vue";
import { settings, type SettingsTab } from "./state";

/**
 * Settings: frappe-ui's SettingsDialog, as on /admin, with Account and Connectors.
 * Cmd+Shift+, (Ctrl+Shift+,) opens it too. On a phone it fills the screen.
 */
const tab = computed({
	get: () => settings.tab,
	set: (value: string | number | undefined) => {
		settings.tab = value as SettingsTab;
		settings.connector = null;
	},
});
const connector = computed(() => connectors.value?.find((each) => each.id === settings.connector));
const attention = computed(() => connectors.value?.filter((each) => each.status !== "connected").length ?? 0);

// The list loads when Settings opens, so a sign-in that ended elsewhere shows. When it
// fails, Connectors shows why, with Retry (connectorsError in connectors/api.ts).
watch(
	() => settings.open,
	(open) => open && void loadConnectors().catch(() => undefined),
	{ immediate: true },
);
</script>

<template>
	<SettingsDialog v-model:open="settings.open" v-model:tab="tab">
		<SettingsSidebar>
			<SettingsNavGroup label="Settings" class="[&>div:first-child]:text-xs-medium">
				<SettingsNavItem value="account" class="!text-sm [@media(pointer:coarse)]:!h-11">
					<template #prefix><span class="lucide-circle-user size-4 text-ink-gray-6" aria-hidden="true" /></template>
					Account
				</SettingsNavItem>
				<SettingsNavItem value="connectors" class="!text-sm [@media(pointer:coarse)]:!h-11">
					<template #prefix><span class="lucide-plug size-4 text-ink-gray-6" aria-hidden="true" /></template>
					Connectors
					<template #suffix>
						<span v-if="attention" class="size-2 rounded-full bg-surface-amber-7" role="img" :aria-label="`${attention} need attention`" />
					</template>
				</SettingsNavItem>
			</SettingsNavGroup>
		</SettingsSidebar>
		<SettingsContent>
			<SettingsPanel value="account"><AccountPanel /></SettingsPanel>
			<SettingsPanel value="connectors">
				<ConnectorPage v-if="connector && !connectorsError" :key="connector.id" :connector="connector" />
				<ConnectorsPanel v-else />
			</SettingsPanel>
		</SettingsContent>
		<!-- Close. A phone has no backdrop to tap, since the dialog fills the screen (style.css). After the content, so the dialog does not open with focus on it. -->
		<Button data-slot="settings-close" class="absolute right-2 top-2 z-10 after:absolute after:inset-0 after:content-[''] sm:right-8 sm:top-9 [@media(pointer:coarse)]:after:-inset-2" variant="ghost" icon="lucide-x" aria-label="Close settings" @click="settings.open = false" />
	</SettingsDialog>
</template>
