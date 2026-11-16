<script setup lang="ts">
import MemoryIntro from "./MemoryIntro.vue";
import MemoryRowsSkeleton from "./MemoryRowsSkeleton.vue";

/**
 * The Memory page (MemoryView.vue) while its code arrives: its intro, its tabs and rows shaped
 * like memories, as it shows while the memories load, so nothing moves when it takes this place.
 * The tabs copy frappe-ui's TabButtons, with Memories chosen.
 */
defineOptions({ inheritAttrs: false });
const tabs = ["Memories", "Decisions", "How it decides"];
</script>

<template>
	<div data-slot="memory-view" class="scroll-fade-y scrollbar-thin [--scroll-fade-range:40px] [--scroll-fade-size:40px] min-h-0 flex-1 overflow-y-auto sm:[scrollbar-gutter:stable_both-edges]">
		<div class="mx-auto w-full max-w-[720px] space-y-5 px-4 py-6 sm:px-5">
			<MemoryIntro />
			<div>
				<div class="relative isolate inline-flex shrink-0 items-center gap-1 rounded-4 bg-surface-gray-2 p-px" aria-hidden="true">
					<span
						v-for="(tab, index) in tabs"
						:key="tab"
						class="inline-flex h-6.5 items-center justify-center whitespace-nowrap rounded-[7px] px-2 py-[5px] text-sm leading-[16.1px]"
						:class="index === 0 ? 'bg-surface-elevation-3 text-ink-gray-8 shadow-base' : 'text-ink-gray-5'"
					>
						{{ tab }}
					</span>
				</div>
			</div>
			<MemoryRowsSkeleton />
		</div>
	</div>
</template>
