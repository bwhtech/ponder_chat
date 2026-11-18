<script setup lang="ts">
import type { SetupStepKey } from "./onboarding";

/**
 * The small scene at the top of a setup card (WorkspaceSetupCard.vue), drawn with CSS, in the
 * gray tones, so it follows dark mode. Instructions: a Markdown note with a pencil. Documents:
 * a fan of files and a tile to add one. People: faces and an invite. The card is the `group`:
 * on its hover the scene moves a little toward what the step does (the pencil writes, the
 * files spread, the faces make room). Decoration only: hidden from screen readers.
 */
defineProps<{ kind: SetupStepKey }>();

// Each class is written out whole: Tailwind only makes the names it can read.
const MOVE = "transition-transform duration-300 ease-out-strong motion-reduce:transition-none";
// The side files' labels sit on their outer edge, where the middle file does not cover them.
const FILES = [
	{ type: "PDF", tag: "self-start", place: "left-0 z-0 origin-bottom -rotate-[9deg] group-hover:-translate-x-1.5 group-hover:-rotate-[13deg]" },
	{ type: "MD", tag: "self-start", place: "left-7 z-10 -translate-y-1 shadow-md group-hover:-translate-y-3" },
	{ type: "DOC", tag: "self-end", place: "left-14 z-0 origin-bottom rotate-[9deg] group-hover:translate-x-1.5 group-hover:rotate-[13deg]" },
];
const FACES = [
	{ initial: "A", tone: "bg-surface-gray-3 text-ink-gray-7", place: "group-hover:-translate-x-1.5" },
	{ initial: "M", tone: "bg-surface-gray-5 text-ink-gray-1", place: "z-10 -ml-3 group-hover:-translate-y-1" },
	{ initial: "J", tone: "bg-surface-gray-2 text-ink-gray-6", place: "-ml-3 group-hover:translate-x-1.5" },
];
</script>

<template>
	<div class="relative flex h-36 items-center justify-center overflow-hidden rounded-4 bg-surface-gray-1" aria-hidden="true">
		<!-- The scene's shadow on the floor. -->
		<span class="absolute bottom-5 h-3 w-32 rounded-full bg-surface-gray-4 opacity-50 blur-md" />

		<div v-if="kind === 'instructions'" class="relative">
			<div :class="[MOVE, 'absolute inset-0 -translate-x-2.5 -rotate-[7deg] rounded-4 bg-surface-gray-3 group-hover:-translate-x-4 group-hover:-rotate-[11deg]']" />
			<div :class="[MOVE, 'relative flex h-[6.5rem] w-24 flex-col gap-1.5 rounded-4 bg-surface-base p-2.5 shadow-lg ring-1 ring-outline-gray-1 group-hover:-translate-y-1 group-hover:rotate-1']">
				<div class="flex items-center gap-1">
					<span class="text-2xs font-semibold leading-none text-ink-gray-5">#</span>
					<span class="h-1.5 w-10 rounded-full bg-surface-gray-5" />
				</div>
				<span class="mt-0.5 h-1 w-full rounded-full bg-surface-gray-3" />
				<span class="h-1 w-11/12 rounded-full bg-surface-gray-3" />
				<span class="h-1 w-full rounded-full bg-surface-gray-3" />
				<!-- The line being written: it grows as the pencil moves along it. -->
				<span :class="[MOVE, 'h-1 w-full origin-left scale-x-[0.35] rounded-full bg-surface-gray-4 group-hover:scale-x-[0.8]']" />
			</div>
			<span
				:class="[
					MOVE,
					'absolute -bottom-2 -right-5 flex size-9 items-center justify-center rounded-full bg-surface-base text-ink-gray-7 shadow-md ring-1 ring-outline-gray-1 group-hover:-translate-x-3 group-hover:-rotate-12',
				]"
			>
				<span class="lucide-pencil size-4" />
			</span>
		</div>

		<div v-else-if="kind === 'documents'" class="flex items-end">
			<div class="relative h-[5.25rem] w-28">
				<div
					v-for="file in FILES"
					:key="file.type"
					:class="[MOVE, file.place, 'absolute bottom-0 flex h-[4.5rem] w-14 flex-col gap-1 rounded-3 bg-surface-base p-1.5 shadow-sm ring-1 ring-outline-gray-1']"
				>
					<span :class="file.tag" class="rounded-1 bg-surface-gray-2 px-1 text-[9px] font-semibold leading-[14px] text-ink-gray-6">{{ file.type }}</span>
					<span class="mt-0.5 h-1 w-full rounded-full bg-surface-gray-3" />
					<span class="h-1 w-3/4 rounded-full bg-surface-gray-3" />
					<span class="h-1 w-full rounded-full bg-surface-gray-3" />
				</div>
			</div>
			<div
				class="ms-3 flex h-[4.5rem] w-12 items-center justify-center rounded-3 border border-dashed border-outline-gray-3 text-ink-gray-5 transition-[border-color,color,transform] duration-300 ease-out-strong group-hover:-translate-y-1 group-hover:border-outline-gray-5 group-hover:text-ink-gray-8 motion-reduce:transition-none"
			>
				<span class="lucide-plus size-4" />
			</div>
		</div>

		<div v-else class="flex flex-col items-center gap-3">
			<div class="flex">
				<span
					v-for="face in FACES"
					:key="face.initial"
					:class="[MOVE, face.tone, face.place, 'relative flex size-11 items-center justify-center rounded-full border-[3px] border-[--surface-gray-1] text-base font-medium shadow-sm']"
				>
					{{ face.initial }}
				</span>
			</div>
			<span
				:class="[MOVE, 'flex items-center gap-1 rounded-full bg-surface-base px-2.5 py-1 text-xs text-ink-gray-7 shadow-sm ring-1 ring-outline-gray-1 delay-75 group-hover:-translate-y-0.5']"
			>
				<span class="lucide-user-plus size-3" />
				Invite
			</span>
		</div>
	</div>
</template>
