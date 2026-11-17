<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { skillTitle, type SkillOption } from "./skills";

/**
 * The list of skills over the message box (picker.ts), or under it (`below`) where the box
 * sits near the top of the page. mousedown.prevent on each row keeps the focus in the
 * textarea, so typing keeps filtering.
 */
const props = defineProps<{ items: SkillOption[]; query: string; active: number; below?: boolean }>();
const emit = defineEmits<{ choose: [skill: SkillOption]; hover: [index: number] }>();

const list = ref<HTMLElement | null>(null);
watch(
	() => props.active,
	async (index) => {
		await nextTick();
		list.value?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
	},
);
</script>

<template>
	<div
		data-slot="skill-menu"
		class="absolute inset-x-0 z-20 overflow-hidden rounded-6 bg-surface-elevation-2 shadow-xl ring-1 ring-outline-gray-2"
		:class="below ? 'top-full mt-2' : 'bottom-full mb-2'"
	>
		<div class="flex h-9 items-center gap-2 border-b border-outline-gray-1 px-3">
			<span class="text-sm font-medium text-ink-gray-7">Skills</span>
			<span v-if="query" class="truncate text-sm text-ink-gray-5">matching “{{ query }}”</span>
		</div>
		<div v-if="items.length" ref="list" id="skill-menu" role="listbox" aria-label="Skills" class="max-h-72 overflow-y-auto p-1.5">
			<div
				v-for="(skill, index) in items"
				:key="skill.name"
				:id="`skill-option-${skill.name}`"
				role="option"
				:data-index="index"
				:aria-selected="index === active"
				:title="skill.description"
				class="flex h-9 cursor-pointer items-center gap-2.5 rounded-4 px-2.5"
				:class="index === active ? 'bg-surface-gray-3' : ''"
				@mouseenter="emit('hover', index)"
				@mousedown.prevent="emit('choose', skill)"
			>
				<span class="shrink-0 text-sm font-medium text-ink-gray-9">{{ skillTitle(skill.name) }}</span>
				<span class="min-w-0 flex-1 truncate text-sm text-ink-gray-5">{{ skill.description }}</span>
			</div>
		</div>
		<p v-else class="px-3 py-4 text-p-sm text-ink-gray-6">No skill matches “{{ query }}”.</p>
		<div class="hidden items-center gap-3 border-t border-outline-gray-1 px-3 py-1.5 text-xs text-ink-gray-5 sm:flex">
			<span>↑↓ to move</span>
			<span>↵ or Tab to use</span>
			<span>Esc to close</span>
		</div>
	</div>
</template>
