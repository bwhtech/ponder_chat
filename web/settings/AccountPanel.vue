<script setup lang="ts">
import { Button, SettingsRow } from "frappe-ui";
import { me, signOut } from "../account";
import { credits } from "../numbers";
import PanelBody from "./PanelBody.vue";
import PanelHeader from "./PanelHeader.vue";
import { creditsNote } from "./state";
</script>

<template>
	<PanelHeader title="Account" />
	<PanelBody>
		<div v-if="me" class="divide-y divide-outline-gray-1">
			<SettingsRow title="Signed in as" :description="me.user.email">
				<Button icon-left="lucide-log-out" label="Sign out" @click="signOut" />
			</SettingsRow>
			<SettingsRow
				title="Daily credits"
				:description="creditsNote(me.credits)"
			>
				<span class="whitespace-nowrap text-sm tabular-nums text-ink-gray-6">{{ credits(me.credits.remaining) }} left today</span>
			</SettingsRow>
		</div>
	</PanelBody>
</template>
