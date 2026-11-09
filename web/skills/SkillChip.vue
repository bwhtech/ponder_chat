<script setup lang="ts">
import { Tooltip } from "frappe-ui";
import { computed } from "vue";
import { skillDescription, skillTitle } from "./skills";

/** A skill the person chose: in the message box (removable), and on their sent message. */
const props = defineProps<{ name: string; removable?: boolean }>();
defineEmits<{ remove: [] }>();

const title = computed(() => skillTitle(props.name));
</script>

<template>
	<Tooltip :text="skillDescription(name) ?? ''" :disabled="!skillDescription(name)">
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
	</Tooltip>
</template>
