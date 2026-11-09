<script setup lang="ts">
import { Button, SettingsContent, SettingsDialog, SettingsNavGroup, SettingsNavItem, SettingsPanel, SettingsSidebar } from "frappe-ui";
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
			<SettingsNavGroup label="Settings" class="[&>div:first-child]:text-xs-medium">
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
		<!-- Close, as in the chat's Settings. After the content, so the dialog does not open with focus on it. -->
		<Button data-slot="settings-close" class="absolute right-2 top-2 z-10 sm:right-5 sm:top-[1.875rem]" variant="ghost" icon="lucide-x" aria-label="Close settings" @click="open = false" />
	</SettingsDialog>
</template>
