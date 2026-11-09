<script setup lang="ts">
import { Button } from "frappe-ui";
import PanelBody from "../../settings/PanelBody.vue";
import PanelHeader from "../../settings/PanelHeader.vue";
import { useSettingsForm } from "../lib/settings-form";
import GeneralSettings from "./GeneralSettings.vue";

/** The General tab of the settings dialog. Mounted only while it shows, so the values load fresh each time. */
const form = useSettingsForm();
</script>

<template>
	<PanelHeader title="General">
		<template #actions>
			<Button v-if="!form.loadError" variant="solid" theme="gray" label="Save" :loading="form.saving" :disabled="!form.canSave" @click="form.save" />
		</template>
	</PanelHeader>
	<PanelBody>
		<GeneralSettings :form="form" />
	</PanelBody>
</template>
