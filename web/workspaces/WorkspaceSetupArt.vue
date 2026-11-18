<script setup lang="ts">
import type { SetupStepKey } from "./onboarding";

/**
 * The small scene at the top of a setup card (WorkspaceSetupCard.vue), drawn with CSS, in the
 * gray tones, so it follows dark mode. Instructions: a Markdown note with a pencil. Documents:
 * a fan of files and a tile to add one. People: faces and a free seat. The card is the `group`:
 * on its hover the scene moves a little toward what the step does (the pencil writes, the
 * files spread, the faces make room), where the pointer can hover and motion is allowed (the
 * `pose:` variant, tailwind.config.js). `compact`: the same scene, scaled into a 64px tile, for
 * the rows on a narrow column. Decoration only: hidden from screen readers.
 *
 * In dark mode the objects get their own lighter surfaces, so they stand out from the stage,
 * and the shadow on the floor is dark, not a glow.
 */
defineProps<{ kind: SetupStepKey; compact?: boolean }>();

// Each class is written out whole: Tailwind only makes the names it can read.
const MOVE = "transition-transform duration-300 ease-out-strong";
const PAPER = "bg-surface-base ring-1 ring-outline-gray-1 dark:bg-surface-gray-3 dark:ring-outline-gray-3";
const LINE = "h-1 rounded-full bg-surface-gray-3 dark:bg-surface-gray-5";
// The side files' labels sit on their outer edge, where the middle file does not cover them.
const FILES = [
	{ type: "PDF", tag: "self-start", place: "left-0 z-0 origin-bottom -rotate-[7deg] pose:-rotate-[11deg]" },
	{ type: "MD", tag: "self-start", place: "left-[26px] z-10 -translate-y-1 shadow-md pose:-translate-y-2" },
	{ type: "DOC", tag: "self-end", place: "left-[52px] z-0 origin-bottom rotate-[7deg] pose:rotate-[11deg]" },
];
// The faces move apart, to make room for whoever is added next.
const FACES = [
	{ initial: "A", tone: "bg-surface-gray-3 text-ink-gray-7 dark:bg-surface-gray-4", place: "pose:-translate-x-2" },
	{ initial: "M", tone: "z-10 bg-surface-gray-5 text-ink-gray-1 dark:text-ink-gray-8", place: "-ms-3 pose:-translate-x-1 pose:-translate-y-1" },
	{ initial: "J", tone: "z-[1] bg-surface-gray-2 text-ink-gray-6 dark:bg-surface-gray-3 dark:text-ink-gray-7", place: "-ms-3" },
];
</script>

<template>
	<div class="relative isolate overflow-hidden rounded-4 bg-surface-gray-1" :class="compact ? 'size-16' : 'h-40'" aria-hidden="true">
		<!-- The scene is drawn at the card's size; in a tile it is scaled down from its middle. -->
		<div
			class="flex items-center justify-center"
			:class="compact ? 'absolute left-1/2 top-1/2 h-40 w-[200px] -translate-x-1/2 -translate-y-1/2 scale-[0.36]' : 'absolute inset-0'"
		>
			<!-- The scene's shadow on the floor. -->
			<span class="absolute bottom-5 h-3 w-32 rounded-full bg-surface-gray-4 opacity-50 blur-md dark:bg-black dark:opacity-40" />

			<div v-if="kind === 'instructions'" class="relative">
				<div :class="[MOVE, 'absolute inset-0 -translate-x-2.5 -rotate-[7deg] rounded-4 bg-surface-gray-3 dark:bg-surface-gray-2 dark:ring-1 dark:ring-outline-gray-2 pose:-translate-x-4 pose:-rotate-[11deg]']" />
				<div :class="[MOVE, PAPER, 'relative flex h-[6.5rem] w-24 flex-col gap-1.5 rounded-4 p-2.5 shadow-lg pose:-translate-y-1 pose:rotate-1']">
					<div class="flex items-center gap-1">
						<span class="text-2xs font-semibold leading-none text-ink-gray-5">#</span>
						<span class="h-1.5 w-10 rounded-full bg-surface-gray-5 dark:bg-surface-gray-6" />
					</div>
					<span :class="[LINE, 'mt-0.5 w-full']" />
					<span :class="[LINE, 'w-11/12']" />
					<span :class="[LINE, 'w-full']" />
					<!-- The line being written: it grows as the pencil moves along it. -->
					<span :class="[MOVE, 'h-1 w-full origin-left scale-x-[0.35] rounded-full bg-surface-gray-4 dark:bg-surface-gray-6 pose:scale-x-[0.8]']" />
				</div>
				<span
					:class="[
						MOVE,
						'absolute -bottom-2 -right-5 flex size-9 items-center justify-center rounded-full bg-surface-base text-ink-gray-7 shadow-md ring-1 ring-outline-gray-1 dark:bg-surface-gray-4 dark:text-ink-gray-8 dark:ring-outline-gray-4 pose:-translate-x-3 pose:-rotate-12',
					]"
				>
					<span class="lucide-pencil size-4" />
				</span>
			</div>

			<!-- The fan's box starts 8px in: the left file leans out of it by about that much. -->
			<div v-else-if="kind === 'documents'" class="flex items-end">
				<div class="relative ms-2 h-16 w-24">
					<div v-for="file in FILES" :key="file.type" :class="[MOVE, PAPER, file.place, 'absolute bottom-0 flex h-[3.75rem] w-11 flex-col gap-1 rounded-3 p-1.5 shadow-sm']">
						<span :class="file.tag" class="rounded-1 bg-surface-gray-2 px-1 text-[9px] font-semibold leading-[14px] text-ink-gray-6 dark:bg-surface-gray-5 dark:text-ink-gray-8">{{ file.type }}</span>
						<span :class="[LINE, 'mt-0.5 w-full']" />
						<span :class="[LINE, 'w-3/4']" />
						<span :class="[LINE, 'w-full']" />
					</div>
				</div>
				<div
					class="ms-5 flex h-[3.75rem] w-10 items-center justify-center rounded-3 border border-dashed border-outline-gray-3 text-ink-gray-5 transition-[border-color,color,transform] duration-300 ease-out-strong group-hover:border-outline-gray-5 group-hover:text-ink-gray-8 dark:border-outline-gray-4 pose:-translate-y-1"
				>
					<span class="lucide-plus size-4" />
				</div>
			</div>

			<div v-else class="flex">
				<span
					v-for="face in FACES"
					:key="face.initial"
					:class="[MOVE, face.tone, face.place, 'relative flex size-11 items-center justify-center rounded-full border-[3px] border-[--surface-gray-1] text-base font-medium shadow-sm']"
				>
					{{ face.initial }}
				</span>
				<!-- The free seat: a dashed circle, as the Documents tile, tucked behind the faces. -->
				<span
					class="relative -ms-3 flex size-11 items-center justify-center rounded-full border border-dashed border-outline-gray-3 bg-surface-gray-1 text-ink-gray-5 transition-[border-color,color,transform] duration-300 ease-out-strong group-hover:border-outline-gray-5 group-hover:text-ink-gray-8 dark:border-outline-gray-4 pose:translate-x-1.5"
				>
					<span class="lucide-plus size-4" />
				</span>
			</div>
		</div>
	</div>
</template>
