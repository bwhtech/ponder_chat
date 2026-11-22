<script setup lang="ts">
import { Button } from "frappe-ui";
import { onMounted, ref, shallowRef, type Component } from "vue";
import { me, refreshCredits } from "../account";
import { ApiError, client, unwrap, type Answer } from "../api";
import EmptyState from "../EmptyState.vue";
import PanelBody from "./PanelBody.vue";
import PanelHeader from "./PanelHeader.vue";
import { USAGE_INTRO } from "./state";
import UsageSkeleton from "./UsageSkeleton.vue";
import UsageToday from "./UsageToday.vue";

/** Settings, Usage: today's credits (the sidebar's `me.credits`), then the last 30 days and what used them. */
const loaded = shallowRef<{ usage: Answer<typeof client.api.credits.usage.$get>; Charts: Component }>();
/** The last load failed. Its error replaces the lower cards, with Try again; today's credits stay. */
const loadError = ref("");

onMounted(load);

let asked = 0;

async function load() {
	const mine = ++asked;
	loadError.value = "";
	loaded.value = undefined;
	// The sidebar and this tab read the same numbers, so both move together.
	void refreshCredits().catch(() => undefined);
	try {
		const [usage, { default: Charts }] = await Promise.all([
			unwrap(client.api.credits.usage.$get(), "The server had a problem. Try again in a moment."),
			import("./UsageCharts.vue"),
		]);
		if (mine === asked) loaded.value = { usage, Charts };
	} catch (error) {
		if (mine === asked) loadError.value = error instanceof ApiError ? error.message : "Check your connection, then try again.";
	}
}
</script>

<template>
	<PanelHeader title="Usage" :description="USAGE_INTRO" />
	<PanelBody>
		<div data-slot="usage-view" class="space-y-4 pt-5">
			<UsageToday v-if="me" :credits="me.credits" />
			<EmptyState v-if="loadError" icon="lucide-circle-alert" title="Your usage could not load" :body="loadError" alert>
				<Button class="touch-target" label="Try again" @click="load" />
			</EmptyState>
			<UsageSkeleton v-else-if="!loaded" />
			<EmptyState
				v-else-if="!loaded.usage.total"
				icon="lucide-gauge"
				title="No usage in the last 30 days"
				body="Credits you use on replies will show here."
			/>
			<component :is="loaded.Charts" v-else :usage="loaded.usage" />
		</div>
	</PanelBody>
</template>
