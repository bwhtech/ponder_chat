<script setup lang="ts">
import { Progress } from "frappe-ui";
import { computed } from "vue";
import { credits } from "../lib/format";

/** Credits used today against today's limit. */
const props = defineProps<{ used: number; limit: number }>();
const full = computed(() => props.used >= props.limit);
/** Amber from 80% used, as the chat's meter is under 20% left. */
const low = computed(() => !full.value && props.used >= props.limit * 0.8);
const percent = computed(() => (props.limit > 0 ? Math.min(100, (props.used / props.limit) * 100) : full.value ? 100 : 0));
</script>

<template>
	<div class="flex w-full items-center gap-2.5">
		<div class="shrink-0 text-sm tabular-nums">
			<span :class="full ? 'text-ink-red-6' : low ? 'text-ink-amber-6' : 'text-ink-gray-8'">{{ credits(used) }}</span>
			<span class="text-ink-gray-5"> / {{ credits(limit) }}</span>
		</div>
		<Progress
			:value="percent"
			size="md"
			:class="full ? '[&_[role=progressbar]>*]:!bg-surface-red-5' : low ? '[&_[role=progressbar]>*]:!bg-surface-amber-5' : '[&_[role=progressbar]>*]:!bg-surface-gray-6'"
			class="!w-auto min-w-0 max-w-16 flex-1 [&_[role=progressbar]>*]:duration-300 [&_[role=progressbar]>*]:ease-out-strong [&_[role=progressbar]]:bg-surface-gray-3"
		/>
	</div>
</template>
