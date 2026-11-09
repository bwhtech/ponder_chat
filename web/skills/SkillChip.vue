<script setup lang="ts">
import { HoverCard } from "frappe-ui";
import { computed, ref } from "vue";
import { skillDescription, skillsLoaded, skillTitle } from "./skills";

/**
 * A skill the person chose: in the message box (removable), and on their sent message.
 * Hovering it shows what the skill does. A skill an admin turned off or deleted since
 * has no description, so the card says so.
 */
const props = defineProps<{ name: string; removable?: boolean }>();
defineEmits<{ remove: [] }>();

const title = computed(() => skillTitle(props.name));
// Never opens empty: before the skills list loads, there is nothing to show.
const open = ref(false);
const description = computed(() => skillDescription(props.name) ?? (skillsLoaded.value ? "This skill is off now." : ""));
</script>

<template>
	<HoverCard :open="open" :hover-delay="300" :leave-delay="100" side="top" @update:open="open = $event && Boolean(description)">
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
		<div class="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-1 p-3">
			<p class="flex items-center gap-1.5 text-sm-medium text-ink-gray-8">
				<span class="lucide-sparkles size-3.5 shrink-0 text-ink-violet-7" aria-hidden="true" />
				{{ title }}
			</p>
			<p class="text-p-xs text-ink-gray-6">{{ description }}</p>
		</div>
	</HoverCard>
</template>
