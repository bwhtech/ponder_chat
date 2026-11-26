<script setup lang="ts">
import { Skeleton } from "frappe-ui";

/**
 * The Usage tab's two lower cards while their numbers and the chart's code arrive, in
 * UsagePanel.vue and in Settings' stand-in. The titles stay as text; bars stand only
 * where values go.
 */
</script>

<template>
	<div class="space-y-4" aria-busy="true" aria-label="Loading usage">
		<div data-slot="dashboard" class="flex h-60 flex-col gap-1.5 rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:h-64 md:p-4">
			<div>
				<div class="text-p-base text-ink-gray-8">Credits used per day</div>
				<div class="flex h-[1lh] items-center text-p-sm"><Skeleton class="h-3 w-40 rounded-4" /></div>
			</div>
			<div class="min-h-0 flex-1 pb-3"><Skeleton class="h-full w-full rounded-4" /></div>
		</div>
		<div data-slot="dashboard" class="rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:p-4">
			<div class="text-p-base text-ink-gray-8">What used them</div>
			<div class="flex h-[1lh] items-center text-p-sm"><Skeleton class="h-3 w-40 rounded-4" /></div>
			<ul class="mt-3 space-y-3">
				<li v-for="width in ['w-32', 'w-24', 'w-36']" :key="width" class="space-y-1.5">
					<div class="flex h-[1lh] items-center justify-between gap-3 text-p-sm">
						<Skeleton :class="['h-3 rounded-4', width]" />
						<Skeleton class="h-3 w-8 rounded-4" />
					</div>
					<div class="h-1 rounded-full bg-surface-gray-3" />
				</li>
			</ul>
		</div>
	</div>
</template>
