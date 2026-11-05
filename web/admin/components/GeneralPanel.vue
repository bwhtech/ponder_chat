<script setup lang="ts">
import { Button, SettingsBody, SettingsHeader } from "frappe-ui";
import { useSettingsForm } from "../lib/settings-form";
import GeneralSettings from "./GeneralSettings.vue";

/** The General tab of the settings dialog. Mounted only while it shows, so the values load fresh each time. */
const form = useSettingsForm();
</script>

<template>
	<SettingsHeader title="General">
		<template #actions>
			<Button variant="solid" theme="gray" label="Save" :loading="form.saving" :disabled="!form.canSave" @click="form.save" />
		</template>
	</SettingsHeader>
	<SettingsBody>
		<GeneralSettings :form="form" />
	</SettingsBody>
</template>
