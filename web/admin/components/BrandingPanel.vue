<script setup lang="ts">
import PanelBody from "../../settings/PanelBody.vue";
import PanelHeader from "../../settings/PanelHeader.vue";
import BrandingSettings from "./BrandingSettings.vue";

/** The Branding tab of the settings dialog. Each change saves at once, so there is no Save. */
</script>

<template>
	<PanelHeader title="Branding" />
	<PanelBody>
		<BrandingSettings />
	</PanelBody>
</template>
