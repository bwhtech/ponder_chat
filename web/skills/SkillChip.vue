<script setup lang="ts">
import { HoverCard } from "frappe-ui";
import { computed, ref } from "vue";
import { skillDescription, skillTitle } from "./skills";

/**
 * A skill the person chose: in the message box (removable), and on their sent message.
 * Hovering it shows a card with what the skill does and its $name.
 */
const props = defineProps<{ name: string; removable?: boolean }>();
defineEmits<{ remove: [] }>();

const title = computed(() => skillTitle(props.name));
const description = computed(() => skillDescription(props.name));
// Opens only with a description: none before the skills list loads, or for a skill that is off.
const open = ref(false);
</script>

<template>
	<HoverCard :open="open" :hover-delay="300" :leave-delay="100" :offset="6" side="top" @update:open="open = $event && Boolean(description)">
		<template #trigger>
			<span
				data-slot="skill-chip"
				class="inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-surface-violet-2 pl-2 text-sm text-ink-violet-7"
				:class="removable ? 'pr-1' : 'pr-2.5'"
			>
				<span class="lucide-sparkles size-3.5 shrink-0" aria-hidden="true" />
				<span class="truncate">{{ title }}</span>
				<button
					v-if="removable"
					type="button"
					class="touch-target ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-surface-violet-3"
					:aria-label="`Remove ${title}`"
					@click="$emit('remove')"
				>
					<span class="lucide-x size-3" aria-hidden="true" />
				</button>
			</span>
		</template>
		<div data-slot="skill-card" class="w-80 max-w-[calc(100vw-2rem)] p-3">
			<div class="flex items-center gap-2.5">
				<span class="flex size-8 shrink-0 items-center justify-center rounded-4 bg-surface-violet-2 text-ink-violet-7" aria-hidden="true">
					<span class="lucide-sparkles size-4" />
				</span>
				<div class="min-w-0 flex-1">
					<p class="truncate text-base-semibold text-ink-gray-9">{{ title }}</p>
					<p class="mt-0.5 truncate font-mono text-xs text-ink-gray-5">${{ name }}</p>
				</div>
			</div>
			<p class="mt-2.5 text-p-sm text-ink-gray-7">{{ description }}</p>
		</div>
	</HoverCard>
</template>
