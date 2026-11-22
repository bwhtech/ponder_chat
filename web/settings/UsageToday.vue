<script setup lang="ts">
import { computed } from "vue";
import type { Credits } from "../account";
import CreditMeter from "../CreditMeter.vue";
import { clockTime, fromNow } from "../dates";
import { credits as creditCount } from "../numbers";

/** The Usage tab's first card: the sidebar's meter, from the same `me.credits`, with the refill in local time. */
const props = defineProps<{ credits: Credits }>();

const note = computed(() => {
	const { resetsAt, extra } = props.credits;
	const refill = `Refills ${fromNow(resetsAt)}, at ${clockTime(resetsAt)}`;
	return extra ? `${refill} · Includes ${creditCount(extra)} extra ${extra === 1 ? "credit" : "credits"} from an admin` : refill;
});
</script>

<template>
	<section data-slot="dashboard" aria-label="Today" class="rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:p-4">
		<h3 class="text-p-base text-ink-gray-8">Today</h3>
		<!-- The negative margin takes back the meter's own inset, which lines it up in the sidebar. -->
		<CreditMeter :credits="credits" class="-mx-2 -mb-2">
			<template #refill>{{ note }}</template>
		</CreditMeter>
	</section>
</template>
