<script setup lang="ts">
import { SettingsContent, SettingsDialog, SettingsNavGroup, SettingsNavItem, SettingsPanel, SettingsSidebar } from "frappe-ui";
import { ref, watch } from "vue";
import { useRoute } from "vue-router";
import GeneralPanel from "./GeneralPanel.vue";

/**
 * Settings on wider screens: frappe-ui's SettingsDialog, opened from the account menu or
 * with Cmd+Shift+, (Ctrl+Shift+,). One tab for now, General. Changes not saved are
 * dropped when it closes.
 */
const open = defineModel<boolean>("open", { default: false });
const tab = ref("general");
const route = useRoute();

// A link inside, such as to an admin's page, closes the dialog.
watch(() => route.fullPath, () => (open.value = false));
</script>

<template>
	<SettingsDialog v-model:open="open" v-model:tab="tab">
		<SettingsSidebar>
			<SettingsNavGroup label="Settings">
				<SettingsNavItem value="general">
					<template #prefix><span class="lucide-settings size-4 text-ink-gray-6" aria-hidden="true" /></template>
					General
				</SettingsNavItem>
			</SettingsNavGroup>
		</SettingsSidebar>
		<SettingsContent>
			<SettingsPanel value="general">
				<GeneralPanel />
			</SettingsPanel>
		</SettingsContent>
	</SettingsDialog>
</template>
