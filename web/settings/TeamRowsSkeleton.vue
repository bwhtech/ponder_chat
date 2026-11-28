<script setup lang="ts">
import { Skeleton } from "frappe-ui";

/** A team shaped like TeamsPanel's while it loads: its name, then two members (TeamsPanel.vue, SettingsPlaceholder.vue). */
</script>

<template>
	<div class="space-y-4" aria-busy="true" aria-label="Loading your teams">
		<section v-for="n in 2" :key="n" class="rounded-6 border border-outline-gray-2">
			<div class="flex h-[1lh] items-center px-3 pt-3 text-base-semibold"><Skeleton class="h-4 w-32 rounded-4" /></div>
			<ul class="divide-y divide-outline-gray-1 px-3 pb-1 pt-2">
				<li v-for="m in 2" :key="m" class="flex items-center gap-3 py-2.5">
					<Skeleton class="size-8 rounded-full" />
					<div class="flex-1 space-y-1.5">
						<Skeleton class="h-3.5 w-28 rounded-4" />
						<Skeleton class="h-3 w-44 rounded-4" />
					</div>
				</li>
			</ul>
		</section>
	</div>
</template>
