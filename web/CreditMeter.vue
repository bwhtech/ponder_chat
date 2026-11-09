<script setup lang="ts">
import { computed } from "vue";
import type { Credits } from "./account";
import { fromNow } from "./dates";
import { credits as creditCount } from "./numbers";

/** Today's credits: what is left, a bar, and when they refill. */
const props = defineProps<{ credits: Credits }>();

const left = computed(() => Math.max(0, Math.min(1, props.credits.remaining / Math.max(1, props.credits.limit))));
const low = computed(() => left.value < 0.2);
const refill = computed(() => `Refills ${fromNow(props.credits.resetsAt)}`);
</script>

<template>
	<div class="flex flex-col gap-1.5 rounded-7 px-2 py-2" data-slot="credit-meter">
		<div class="flex items-baseline justify-between gap-2 text-p-sm">
			<span class="text-ink-gray-6">Credits left</span>
			<span class="tabular-nums text-ink-gray-8">
				<span :class="credits.remaining <= 0 ? 'text-ink-red-6' : low ? 'text-ink-amber-6' : ''">{{ creditCount(credits.remaining) }}</span>
				<span class="text-ink-gray-5"> / {{ creditCount(credits.limit) }}</span>
			</span>
		</div>
		<div
			class="h-1 overflow-hidden rounded-full"
			:class="credits.remaining <= 0 ? 'bg-surface-red-2' : 'bg-surface-gray-3'"
			role="meter"
			aria-label="Credits left today"
			:aria-valuenow="credits.remaining"
			aria-valuemin="0"
			:aria-valuemax="credits.limit"
		>
			<div
				class="h-full w-full rounded-full transition-transform duration-300 ease-out-strong motion-reduce:transition-none"
				:class="low ? 'bg-surface-amber-5' : 'bg-surface-gray-6'"
				:style="{ transform: `translateX(${(left - 1) * 100}%)` }"
			/>
		</div>
		<span class="text-p-xs text-ink-gray-6">{{ refill }}</span>
	</div>
</template>
