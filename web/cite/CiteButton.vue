<script setup lang="ts">
import type { PendingCite } from "./selection";

/** The floating Cite button under text selected in a reply (selection.ts). */
defineProps<{ pending: PendingCite }>();
defineEmits<{ cite: [] }>();
</script>

<template>
	<Teleport to="body">
		<button
			type="button"
			data-cite-button
			class="fixed z-50 flex h-7 items-center gap-1.5 rounded-full bg-surface-elevation-2 px-2.5 text-sm text-ink-gray-8 shadow-lg ring-1 ring-outline-gray-2 transition-colors duration-100 hover:bg-surface-gray-2 disabled:text-ink-gray-5 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:px-3.5"
			:style="{ left: `${pending.x}px`, top: `${pending.y}px` }"
			:disabled="pending.tooLong"
			:aria-label="pending.tooLong ? 'The selection is too long to quote' : 'Quote the selection in your message'"
			@pointerdown.prevent
			@click="$emit('cite')"
		>
			<span class="lucide-quote size-3.5" aria-hidden="true" />
			{{ pending.tooLong ? "Shorten selection" : "Cite" }}
		</button>
	</Teleport>
</template>
