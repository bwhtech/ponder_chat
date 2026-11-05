<script setup lang="ts">
import { Button, PageHeaderMobile } from "frappe-ui";
import AccountMenu from "../components/AccountMenu.vue";
import GeneralSettings from "../components/GeneralSettings.vue";
import { useSettingsForm } from "../lib/settings-form";

/** Settings on a phone, where the settings dialog would leave too little room. Wider screens open the dialog (router.ts). */
const form = useSettingsForm();
</script>

<template>
	<PageHeaderMobile title="Settings">
		<template #prefix><AccountMenu compact /></template>
		<template #suffix>
			<Button variant="ghost" label="Save" :loading="form.saving" :disabled="!form.canSave" @click="form.save" />
		</template>
	</PageHeaderMobile>
	<div class="px-3 pb-16">
		<GeneralSettings :form="form" />
	</div>
</template>
