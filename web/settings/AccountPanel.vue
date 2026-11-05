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
			<SettingsRow
				title="Daily credits"
				:description="`You get ${me.credits.limit - me.credits.extra} credits a day. Each reply uses credits by what the model charges for it, so bigger models use more. Credits refill at midnight UTC.${me.credits.extra ? ` Today you also have ${me.credits.extra} extra credits from an admin.` : ''}`"
			>
				<span class="whitespace-nowrap text-sm tabular-nums text-ink-gray-6">{{ me.credits.remaining }} left today</span>
			</SettingsRow>
		</div>
	</PanelBody>
</template>
