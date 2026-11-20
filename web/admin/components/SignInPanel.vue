<script setup lang="ts">
import PanelBody from "../../settings/PanelBody.vue";
import PanelHeader from "../../settings/PanelHeader.vue";
import SignInSettings from "./SignInSettings.vue";

/** The Sign-in tab of the settings dialog. Its own dialog saves, so there is no Save here. */
</script>

<template>
	<PanelHeader title="Sign-in" />
	<PanelBody>
		<SignInSettings />
	</PanelBody>
</template>
