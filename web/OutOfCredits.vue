<script setup lang="ts">
import { Alert } from "frappe-ui";
import { computed } from "vue";
import { me } from "./account";
import { askForMoreCredits, outOfCreditsNotice } from "./credit-request";
import { clockTime } from "./dates";

/**
 * The notice in the message box's place of the suggestions once the day's credits are used
 * up, with Request more credits. Loaded only then (lazy-alert.ts): most days nobody sees it.
 */
const notice = computed(() => outOfCreditsNotice(me.value?.credits, me.value ? clockTime(me.value.credits.resetsAt) : ""));
</script>

<template>
	<Alert
		theme="amber"
		title="You've used today's credits"
		:description="notice.description"
		:primary-action="notice.canAsk ? { label: 'Request more credits', onClick: askForMoreCredits } : undefined"
		data-slot="out-of-credits"
	/>
</template>
