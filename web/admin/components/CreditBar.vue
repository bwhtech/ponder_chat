<script setup lang="ts">
import { Progress } from "frappe-ui";
import { computed } from "vue";
import { credits } from "../lib/format";

/** Credits used today against today's limit. */
const props = defineProps<{ used: number; limit: number }>();
const full = computed(() => props.used >= props.limit);
const percent = computed(() => (props.limit > 0 ? Math.min(100, (props.used / props.limit) * 100) : full.value ? 100 : 0));
</script>

<template>
	<div class="flex w-full flex-col gap-1.5">
		<div class="text-sm tabular-nums">
			<span :class="full ? 'text-ink-red-5' : 'text-ink-gray-8'">{{ credits(used) }}</span>
			<span class="text-ink-gray-5"> / {{ credits(limit) }}</span>
		</div>
		<Progress :value="percent" size="sm" class="!w-24 [&_[role=progressbar]>*]:duration-300 [&_[role=progressbar]>*]:ease-out-strong [&_[role=progressbar]]:bg-surface-gray-4" />
	</div>
</template>
