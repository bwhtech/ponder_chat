<script setup lang="ts">
import { Button, SettingsContent, SettingsDialog, SettingsNavGroup, SettingsNavItem, SettingsPanel, SettingsSidebar } from "frappe-ui";
import { ref, watch } from "vue";
import { useRoute } from "vue-router";
import BrandingPanel from "./BrandingPanel.vue";
import GeneralPanel from "./GeneralPanel.vue";
import SignInPanel from "./SignInPanel.vue";

/**
 * Settings on wider screens: frappe-ui's SettingsDialog, opened from the account menu or
 * with Cmd+Shift+, (Ctrl+Shift+,). Three tabs: General, Branding (the logo) and Sign-in
 * (email, and Microsoft). Changes not saved are dropped when it closes.
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
				<SettingsNavItem value="general" class="!text-sm [@media(pointer:coarse)]:!h-11">
					<template #prefix><span class="lucide-settings size-4 text-ink-gray-6" aria-hidden="true" /></template>
					General
				</SettingsNavItem>
				<SettingsNavItem value="branding" class="!text-sm [@media(pointer:coarse)]:!h-11">
					<template #prefix><span class="lucide-palette size-4 text-ink-gray-6" aria-hidden="true" /></template>
					Branding
				</SettingsNavItem>
				<SettingsNavItem value="sign-in" class="!text-sm [@media(pointer:coarse)]:!h-11">
					<template #prefix><span class="lucide-key-round size-4 text-ink-gray-6" aria-hidden="true" /></template>
					Sign-in
				</SettingsNavItem>
			</SettingsNavGroup>
		</SettingsSidebar>
		<SettingsContent>
			<SettingsPanel value="general">
				<GeneralPanel />
			</SettingsPanel>
			<SettingsPanel value="branding">
				<BrandingPanel />
			</SettingsPanel>
			<SettingsPanel value="sign-in">
				<SignInPanel />
			</SettingsPanel>
		</SettingsContent>
		<!-- Close, as in the chat's Settings. After the content, so the dialog does not open with focus on it. -->
		<Button data-slot="settings-close" class="absolute right-2 top-2 z-10 after:absolute after:inset-0 after:content-[''] sm:right-8 sm:top-9 [@media(pointer:coarse)]:after:-inset-2" variant="ghost" icon="lucide-x" aria-label="Close settings" @click="open = false" />
	</SettingsDialog>
</template>
