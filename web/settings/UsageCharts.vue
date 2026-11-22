<script setup lang="ts">
import { BarChart } from "frappe-ui/charts";
import { computed } from "vue";
import type { Answer, client } from "../api";
import { shortDay } from "../dates";
import { credits } from "../numbers";

/**
 * The Usage tab's chart and breakdown. On its own because the chart library is heavy: the
 * tab loads this file with its data (UsagePanel.vue), so opening Settings does not pay for it.
 */
const props = defineProps<{ usage: Answer<typeof client.api.credits.usage.$get> }>();

const perDay = computed(() => props.usage.days.map((day) => ({ day: shortDay(day.date), Credits: day.credits })));
const period = computed(() => `Last ${props.usage.days.length} days · ${credits(props.usage.total)} credits`);

/** Largest first, as the server sends them, then the calls that run around a reply. */
const lines = computed(() =>
	[...props.usage.models.map((row) => ({ label: row.model, credits: row.credits })), { label: "Memory and summaries", credits: props.usage.memoryAndSummaries }].filter(
		(line) => line.credits > 0,
	),
);
const share = (value: number) => Math.min(1, value / Math.max(props.usage.total, 0.1));

const isPhone = matchMedia("(max-width: 767px)").matches;

/** Charts draw in quickly, and not at all with reduced motion (as on /admin). */
const chartMotion = matchMedia("(prefers-reduced-motion: reduce)").matches ? { animation: false } : { animationDuration: 250, animationDurationUpdate: 200 };
</script>

<template>
	<div class="space-y-4">
		<div data-slot="dashboard" class="h-60 rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:h-64 md:p-4">
			<BarChart
				title="Credits used per day"
				:subtitle="period"
				:data="perDay"
				x="day"
				y="Credits"
				palette="categorical"
				:echart-options="chartMotion"
				:x-axis="{ type: 'category', echartOptions: { axisLabel: { rotate: 0, interval: (index: number) => (perDay.length - 1 - index) % (isPhone ? 7 : 4) === 0, showMinLabel: false, showMaxLabel: true, fontSize: 12 } } }"
				:y-axis="{ echartOptions: { axisLabel: { fontSize: 12 } } }"
			/>
		</div>

		<section v-if="lines.length" data-slot="dashboard" aria-label="What used them" class="rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:p-4">
			<h3 class="text-p-base text-ink-gray-8">What used them</h3>
			<p class="truncate text-p-sm text-ink-gray-5">{{ period }}</p>
			<ul class="mt-3 space-y-3">
				<li v-for="line in lines" :key="line.label" class="space-y-1.5">
					<div class="flex items-baseline justify-between gap-3 text-p-sm">
						<span class="min-w-0 truncate text-ink-gray-8">{{ line.label }}</span>
						<span class="shrink-0 tabular-nums text-ink-gray-8">{{ credits(line.credits) }}</span>
					</div>
					<div class="h-1 overflow-hidden rounded-full bg-surface-gray-3" aria-hidden="true">
						<div class="h-full w-full rounded-full bg-surface-gray-6" :style="{ transform: `translateX(${(share(line.credits) - 1) * 100}%)` }" />
					</div>
				</li>
			</ul>
		</section>
	</div>
</template>
