<script setup lang="ts">
/**
 * The scene at the top of the sidebar's workspace card (WorkspaceIntro.vue): a folder that
 * holds what a workspace holds, the three things its setup cards add (WorkspaceSetupArt.vue).
 * A Markdown note for its instructions, a file for its sources, a face for its people. Drawn
 * with CSS in the gray tones, so it follows dark mode, with the setup scenes' paper and lines.
 * On the card's hover the three rise a little out of the folder (the `pose:` variant,
 * tailwind.config.js). Decoration only: hidden from screen readers.
 */
const MOVE = "transition-transform duration-300 ease-out-strong";
const PAPER = "bg-surface-base ring-1 ring-outline-gray-1 dark:bg-surface-gray-3 dark:ring-outline-gray-3";
const LINE = "h-1 rounded-full bg-surface-gray-3 dark:bg-surface-gray-5";
</script>

<template>
	<div class="relative isolate flex h-24 items-center justify-center overflow-hidden rounded-4 bg-surface-gray-1" aria-hidden="true" data-slot="workspace-intro-art">
		<!-- The folder's shadow on the floor. -->
		<span class="absolute bottom-2 h-2.5 w-32 rounded-full bg-surface-gray-4 opacity-50 blur-md dark:bg-black dark:opacity-40" />

		<div class="relative h-[4.75rem] w-36">
			<!-- The folder's back, with its tab. -->
			<span class="absolute bottom-11 left-0 h-2 w-12 rounded-t-3 bg-surface-gray-3 dark:bg-surface-gray-2 dark:ring-1 dark:ring-outline-gray-2" />
			<span class="absolute inset-x-0 bottom-0 h-11 rounded-4 rounded-tl-none bg-surface-gray-3 dark:bg-surface-gray-2 dark:ring-1 dark:ring-outline-gray-2" />

			<!-- Instructions: a Markdown note, leaning out. -->
			<div :class="[MOVE, PAPER, 'absolute bottom-2.5 left-4 flex h-14 w-12 origin-bottom -rotate-[8deg] flex-col gap-1 rounded-3 p-1.5 shadow-sm pose:-translate-y-1.5 pose:-rotate-[12deg]']">
				<div class="flex items-center gap-0.5">
					<span class="text-[8px] font-semibold leading-none text-ink-gray-5">#</span>
					<span class="h-1 w-5 rounded-full bg-surface-gray-5 dark:bg-surface-gray-6" />
				</div>
				<span :class="[LINE, 'w-full']" />
				<span :class="[LINE, 'w-3/4']" />
				<span :class="[LINE, 'w-full']" />
			</div>

			<!-- Sources: a file, standing up in the middle. -->
			<div :class="[MOVE, PAPER, 'absolute bottom-2.5 left-[3.25rem] z-10 flex h-14 w-12 -translate-y-1 flex-col gap-1 rounded-3 p-1.5 shadow-md pose:-translate-y-3']">
				<span class="self-start rounded-1 bg-surface-gray-2 px-[3px] text-[8px] font-semibold leading-[13px] text-ink-gray-6 dark:bg-surface-gray-5 dark:text-ink-gray-8">PDF</span>
				<span :class="[LINE, 'w-full']" />
				<span :class="[LINE, 'w-1/2']" />
			</div>

			<!-- People: a face, looking out over the edge. -->
			<span
				:class="[
					MOVE,
					'absolute bottom-4 right-4 flex size-10 items-center justify-center rounded-full border-[3px] border-[--surface-gray-1] bg-surface-gray-5 text-base font-medium text-ink-gray-1 shadow-sm dark:text-ink-gray-8 pose:-translate-y-1.5 pose:translate-x-0.5',
				]"
			>
				A
			</span>

			<!-- The folder's front, over the lower part of all three. -->
			<span class="absolute inset-x-0 bottom-0 z-20 flex h-7 items-center rounded-4 bg-surface-gray-2 px-3 shadow-[0_-1px_3px_rgb(0_0_0/0.06)] ring-1 ring-outline-gray-2 dark:bg-surface-gray-3 dark:ring-outline-gray-3">
				<span class="h-1.5 w-9 rounded-full bg-surface-gray-4 dark:bg-surface-gray-5" />
			</span>
		</div>
	</div>
</template>
