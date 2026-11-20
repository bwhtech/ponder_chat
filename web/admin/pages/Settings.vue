<script setup lang="ts">
import { Button, PageHeaderMobile } from "frappe-ui";
import AccountMenu from "../components/AccountMenu.vue";
import BrandingSettings from "../components/BrandingSettings.vue";
import GeneralSettings from "../components/GeneralSettings.vue";
import SignInSettings from "../components/SignInSettings.vue";
import { useSettingsForm } from "../lib/settings-form";

/**
 * Settings on a phone, where the settings dialog would leave too little room: General, then
 * Branding, then Sign-in, on one page. Wider screens open the dialog (router.ts). Save is General's;
 * the logo saves at once, and sign-in in its own dialog.
 */
const form = useSettingsForm();
</script>

<template>
	<PageHeaderMobile title="Settings">
		<template #prefix><AccountMenu compact /></template>
		<template #suffix>
			<Button v-if="!form.loadError" variant="solid" theme="gray" label="Save" :loading="form.saving" :disabled="!form.canSave" @click="form.save" />
		</template>
	</PageHeaderMobile>
	<div class="px-3 pb-16">
		<GeneralSettings :form="form" />
		<!-- Its own top padding makes the 32px between sections. -->
		<BrandingSettings v-if="!form.loadError" class="mt-4" />
		<SignInSettings v-if="!form.loadError" heading class="mt-4" />
	</div>
</template>
