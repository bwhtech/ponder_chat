<script setup lang="ts">
import { computed } from "vue";
import type { SetupStepKey } from "./onboarding";

/**
 * The small scene at the top of a setup card (WorkspaceSetupCard.vue), drawn with CSS, in the
 * gray tones, so it follows dark mode. Instructions: a Markdown note with a pencil. Sources:
 * a fan of files and a tile to add one. People: faces and a free seat. The card is the `group`:
 * on its hover the scene moves a little toward what the step does (the pencil writes, the
 * files spread, the faces make room), where the pointer can hover and motion is allowed (the
 * `pose:` variant, tailwind.config.js). Decoration only: hidden from screen readers.
 *
 * `compact`: a 64px tile for a row (WorkspaceSetup.vue). The scene is drawn at about half size and
 * simpler, so it reads as one bold mark: one note, one file and the tile, two faces and the
 * seat; no labels, no floor shadow, and thicker, darker lines.
 *
 * In dark mode the objects get their own lighter surfaces, so they stand out from the stage,
 * and the shadow on the floor is dark, not a glow.
 */
const props = defineProps<{ kind: SetupStepKey; compact?: boolean }>();

// Each class is written out whole: Tailwind only makes the names it can read.
const MOVE = "transition-transform duration-300 ease-out-strong";
const PAPER = "bg-surface-base ring-1 ring-outline-gray-1 dark:bg-surface-gray-3 dark:ring-outline-gray-3";
const line = computed(() => (props.compact ? "h-1.5 rounded-full bg-surface-gray-5 dark:bg-surface-gray-6" : "h-1 rounded-full bg-surface-gray-3 dark:bg-surface-gray-5"));
/**
 * The fan at 216px card width: 48×72 files, 24px apart, so the middle one leaves the side
 * ones' labels clear. They lean 7°, 10° on hover, from their foot; the box starts 10px in, as
 * the left file leans out of it, so the fan and the tile keep 14px or more from the stage's sides.
 */
const FILES = [
	{ type: "PDF", tag: "self-start", place: "left-0 z-0 origin-bottom -rotate-[7deg] pose:-rotate-[10deg]" },
	{ type: "MD", tag: "self-start", place: "left-6 z-10 -translate-y-1 shadow-md pose:-translate-y-2" },
	{ type: "DOC", tag: "self-end", place: "left-12 z-0 origin-bottom rotate-[7deg] pose:rotate-[10deg]" },
];
// The faces move apart, to make room for whoever is added next.
const FACES = [
	{ initial: "A", tone: "bg-surface-gray-3 text-ink-gray-7 dark:bg-surface-gray-4", place: "pose:-translate-x-1.5" },
	{ initial: "M", tone: "z-10 bg-surface-gray-5 text-ink-gray-1 dark:text-ink-gray-8", place: "-ms-4 pose:-translate-x-1 pose:-translate-y-1" },
	{ initial: "J", tone: "z-[1] bg-surface-gray-2 text-ink-gray-6 dark:bg-surface-gray-3 dark:text-ink-gray-7", place: "-ms-4" },
];
/** The add tile and the free seat: a dashed edge that darkens on hover; in a tile, thicker and darker. */
const dashed = computed(() =>
	props.compact
		? "border-2 border-outline-gray-4 text-ink-gray-6 dark:border-outline-gray-5 dark:text-ink-gray-7"
		: "border border-outline-gray-3 text-ink-gray-5 group-hover:border-outline-gray-5 group-hover:text-ink-gray-8 dark:border-outline-gray-4",
);
/** In a tile, each scene at about half size, as large as fits with a few pixels of air around it. */
const TILE_SCALE: Record<SetupStepKey, string> = { instructions: "scale-[0.44]", documents: "scale-[0.48]", people: "scale-[0.42]" };
const files = computed(() => (props.compact ? FILES.filter((file) => file.type === "MD") : FILES));
const faces = computed(() => (props.compact ? FACES.slice(0, 2) : FACES));
</script>

<template>
	<div class="relative isolate overflow-hidden rounded-4 bg-surface-gray-1" :class="compact ? 'size-16' : 'h-40'" aria-hidden="true">
		<!-- The scene is drawn at the card's size; in a tile it is scaled down from its middle. -->
		<div
			class="flex items-center justify-center"
			:class="compact ? ['absolute left-1/2 top-1/2 h-40 w-[200px] -translate-x-1/2 -translate-y-1/2', TILE_SCALE[kind]] : 'absolute inset-0'"
		>
			<!-- The scene's shadow on the floor. -->
			<span v-if="!compact" class="absolute bottom-5 h-3 w-32 rounded-full bg-surface-gray-4 opacity-50 blur-md dark:bg-black dark:opacity-40" />

			<div v-if="kind === 'instructions'" class="relative">
				<div
					v-if="!compact"
					:class="[MOVE, 'absolute inset-0 -translate-x-2.5 -rotate-[7deg] rounded-4 bg-surface-gray-3 dark:bg-surface-gray-2 dark:ring-1 dark:ring-outline-gray-2 pose:-translate-x-4 pose:-rotate-[11deg]']"
				/>
				<div :class="[MOVE, PAPER, 'relative flex h-[6.5rem] w-24 flex-col gap-1.5 rounded-4 p-2.5 shadow-lg pose:-translate-y-1 pose:rotate-1']">
					<div class="flex items-center gap-1">
						<span v-if="!compact" class="text-2xs font-semibold leading-none text-ink-gray-5">#</span>
						<span class="w-10 rounded-full" :class="compact ? 'h-2 bg-surface-gray-6 dark:bg-surface-gray-7' : 'h-1.5 bg-surface-gray-5 dark:bg-surface-gray-6'" />
					</div>
					<span :class="[line, 'mt-0.5 w-full']" />
					<span :class="[line, 'w-11/12']" />
					<span :class="[line, 'w-full']" />
					<!-- The line being written: it grows as the pencil moves along it. -->
					<span :class="[MOVE, line, 'w-full origin-left scale-x-[0.35] pose:scale-x-[0.8]']" />
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

			<div v-else-if="kind === 'documents'" class="flex items-end">
				<div class="relative h-20" :class="compact ? 'w-12' : 'ms-2.5 w-24'">
					<div v-for="file in files" :key="file.type" :class="[MOVE, PAPER, compact ? 'left-0 z-10' : file.place, 'absolute bottom-0 flex h-[4.5rem] w-12 flex-col gap-1 rounded-3 p-1.5 shadow-sm']">
						<span v-if="!compact" :class="file.tag" class="rounded-1 bg-surface-gray-2 px-[3px] text-[8px] font-semibold leading-[13px] text-ink-gray-6 dark:bg-surface-gray-5 dark:text-ink-gray-8">
							{{ file.type }}
						</span>
						<span :class="[line, 'mt-0.5 w-full']" />
						<span :class="[line, 'w-3/4']" />
						<span :class="[line, 'w-full']" />
						<span :class="[line, 'w-1/2']" />
					</div>
				</div>
				<div
					class="ms-[18px] flex h-[4.5rem] w-10 items-center justify-center rounded-3 border-dashed transition-[border-color,color,transform] duration-300 ease-out-strong pose:-translate-y-1"
					:class="dashed"
				>
					<span class="lucide-plus" :class="compact ? 'size-6' : 'size-4'" />
				</div>
			</div>

			<div v-else class="flex">
				<span
					v-for="face in faces"
					:key="face.initial"
					:class="[MOVE, face.tone, face.place, 'relative flex size-[3.25rem] items-center justify-center rounded-full border-[3px] border-[--surface-gray-1] text-lg font-medium shadow-sm']"
				>
					<!-- In a tile the letters would be a few pixels high: plain discs, as the files have no labels. -->
					<template v-if="!compact">{{ face.initial }}</template>
				</span>
				<!-- The free seat: a dashed circle, as the Sources tile, tucked behind the faces, with someone to add. -->
				<span
					class="relative -ms-4 flex size-[3.25rem] items-center justify-center rounded-full border-dashed bg-surface-gray-1 transition-[border-color,color,transform] duration-300 ease-out-strong pose:translate-x-1"
					:class="dashed"
				>
					<span class="lucide-user-plus" :class="compact ? 'size-7' : 'size-5'" />
				</span>
			</div>
		</div>
	</div>
</template>
