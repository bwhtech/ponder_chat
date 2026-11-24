<script setup lang="ts">
import { Button, SettingsRow } from "frappe-ui";
import { me, signOut } from "../account";
import PanelBody from "./PanelBody.vue";
import PanelHeader from "./PanelHeader.vue";
</script>

<template>
	<PanelHeader title="Account" />
	<PanelBody>
		<div v-if="me" class="divide-y divide-outline-gray-1">
			<SettingsRow title="Signed in as" :description="me.user.email">
				<Button icon-left="lucide-log-out" label="Sign out" @click="signOut" />
			</SettingsRow>
		</div>
	</PanelBody>
</template>
