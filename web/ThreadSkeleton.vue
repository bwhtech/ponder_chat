<script setup lang="ts">
import { Skeleton } from "frappe-ui";

/** Stands in for a thread the device does not have yet: turns shaped like the chat's, and the message field. */
const turns = [
	{ ask: "w-56", lines: ["w-full", "w-11/12", "w-3/5"] },
	{ ask: "w-40", lines: ["w-full", "w-4/5"] },
];
</script>

<template>
	<div class="relative min-h-0 flex-1 overflow-hidden" data-slot="thread-skeleton" aria-busy="true" aria-label="Loading thread">
		<div class="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-4 pt-8 sm:px-5">
			<div v-for="(turn, index) in turns" :key="index" class="flex flex-col gap-6">
				<Skeleton :class="['h-9 max-w-[70%] self-end rounded-7', turn.ask]" />
				<div class="flex flex-col gap-2.5">
					<div class="flex items-center gap-2">
						<Skeleton class="size-4 rounded-full" />
						<Skeleton class="h-3.5 w-32 rounded-4" />
					</div>
					<Skeleton v-for="width in turn.lines" :key="width" :class="['h-3.5 rounded-4', width]" />
				</div>
			</div>
		</div>
	</div>
	<footer class="mx-auto w-full max-w-[720px] shrink-0 px-4 pb-3 sm:px-5">
		<div class="flex h-[104px] flex-col justify-between rounded-7 border border-outline-gray-2 p-3">
			<Skeleton class="h-3.5 w-2/3 rounded-4" />
			<div class="flex items-center gap-2">
				<Skeleton class="size-7 rounded-full" />
				<Skeleton class="h-7 w-24 rounded-full" />
				<Skeleton class="ml-auto size-8 rounded-full" />
			</div>
		</div>
	</footer>
</template>
