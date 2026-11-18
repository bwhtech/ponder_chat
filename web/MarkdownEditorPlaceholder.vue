<script setup lang="ts">
/**
 * MarkdownEditor.vue's box while CodeMirror's code arrives: the same surface, edge, type and
 * padding, with the text it opens with, so the editor takes its place without a jump. It
 * fills the height its parent gives, as the editor does.
 */
defineProps<{ text: string; placeholder: string }>();
</script>

<template>
	<div
		class="h-full overflow-hidden whitespace-pre-wrap break-words rounded-4 border border-outline-gray-2 bg-surface-gray-1 py-3 pl-[2.125rem] pr-3.5 font-mono text-[13px] leading-[1.4]"
		:class="text ? 'text-ink-gray-8' : 'text-ink-gray-4'"
		aria-busy="true"
	>{{ text || placeholder }}</div>
</template>
