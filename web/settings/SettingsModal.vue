<script setup lang="ts">
import { Button, SettingsContent, SettingsDialog, SettingsNavGroup, SettingsNavItem, SettingsPanel, SettingsSidebar } from "frappe-ui";
import { computed, watch } from "vue";
import { connectors, loadConnectors } from "../connectors/api";
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

// The list loads when Settings opens, so a sign-in that ended elsewhere shows.
watch(
	() => settings.open,
	(open) => open && void loadConnectors().catch(() => undefined),
	{ immediate: true },
);
</script>

<template>
	<SettingsDialog v-model:open="settings.open" v-model:tab="tab">
		<!-- On a phone the dialog fills the screen (style.css), so there is no backdrop to tap: it needs a close button. -->
		<Button data-slot="settings-close" class="absolute right-2 top-2 z-10 sm:hidden" variant="ghost" icon="lucide-x" aria-label="Close settings" @click="settings.open = false" />
		<SettingsSidebar>
			<SettingsNavGroup label="Settings">
				<SettingsNavItem value="account">
					<template #prefix><span class="lucide-circle-user size-4 text-ink-gray-6" aria-hidden="true" /></template>
					Account
				</SettingsNavItem>
				<SettingsNavItem value="connectors">
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
				<ConnectorPage v-if="connector" :key="connector.id" :connector="connector" />
				<ConnectorsPanel v-else />
			</SettingsPanel>
		</SettingsContent>
	</SettingsDialog>
</template>
