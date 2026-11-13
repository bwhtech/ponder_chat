<script setup lang="ts">
/** Where the newest summary ends (web/compaction.ts): the model reads a summary of the messages above, not the messages. */
</script>

<template>
	<div role="separator" aria-label="Ponder summarized the messages above" data-slot="compaction-divider" class="flex items-center gap-3 pt-6 text-p-sm text-ink-gray-6">
		<span class="flex-1 border-t border-outline-gray-2" aria-hidden="true" />
		<span class="flex items-center gap-1.5" title="This chat got long, so Ponder now reads a summary of the messages above instead of the messages themselves.">
			<span class="lucide-fold-vertical size-3.5 shrink-0 text-ink-gray-4" aria-hidden="true" />
			Ponder summarized the messages above
		</span>
		<span class="flex-1 border-t border-outline-gray-2" aria-hidden="true" />
	</div>
</template>
