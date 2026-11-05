<script setup lang="ts">
import { computed } from "vue";
import type { Credits } from "./account";

/** Today's credits: what is left, a bar, and when they refill. */
const props = defineProps<{ credits: Credits }>();

const left = computed(() => Math.max(0, Math.min(1, props.credits.remaining / Math.max(1, props.credits.limit))));
const low = computed(() => left.value < 0.2);
const refill = computed(() => {
	const hours = Math.max(0, (new Date(props.credits.resetsAt).getTime() - Date.now()) / 3_600_000);
	if (hours < 1) return "Refills within the hour";
	return `Refills in ${Math.ceil(hours)} h`;
});
const format = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
</script>

<template>
	<div class="flex flex-col gap-1.5 rounded-7 px-2 py-2" data-slot="credit-meter">
		<div class="flex items-baseline justify-between gap-2 text-p-sm">
			<span class="text-ink-gray-6">Credits today</span>
			<span class="tabular-nums text-ink-gray-8">
				<span :class="credits.remaining <= 0 ? 'text-ink-red-6' : low ? 'text-ink-amber-6' : ''">{{ format(credits.remaining) }}</span>
				<span class="text-ink-gray-5"> / {{ credits.limit }}</span>
			</span>
		</div>
		<div
			class="h-1.5 overflow-hidden rounded-full bg-surface-gray-3"
			role="meter"
			aria-label="Credits left today"
			:aria-valuenow="credits.remaining"
			aria-valuemin="0"
			:aria-valuemax="credits.limit"
		>
			<div
				class="h-full rounded-full transition-[width] duration-300 ease-out"
				:class="credits.remaining <= 0 ? 'bg-surface-red-5' : low ? 'bg-surface-amber-5' : 'bg-surface-gray-7'"
				:style="{ width: `${left * 100}%` }"
			/>
		</div>
		<span class="text-p-xs text-ink-gray-5">{{ refill }}</span>
	</div>
</template>
