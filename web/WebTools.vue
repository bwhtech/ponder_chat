<script setup lang="ts">
import { Button } from "frappe-ui";

/**
 * Web and Research in a message box (web-tools.ts). Two switches drawn as the model menu's
 * button is, so the row reads as one. On a phone they are icons only: the row also holds the
 * model and the workspace.
 */
defineProps<{ disabled?: boolean }>();
/** Web search for the chat. */
const web = defineModel<boolean>("web", { required: true });
/** Deep research for the next message. */
const research = defineModel<boolean>("research", { required: true });

const base = "relative shrink-0 after:absolute after:inset-0 after:content-[''] [@media(pointer:coarse)]:after:-inset-y-2";
const off = "!text-ink-gray-6 hover:!text-ink-gray-8";
</script>

<template>
	<Button
		:variant="web ? 'subtle' : 'ghost'"
		:theme="web ? 'blue' : 'gray'"
		size="sm"
		icon-left="lucide-globe"
		data-slot="web-toggle"
		:aria-pressed="web"
		aria-label="Web search"
		:title="web ? 'Web search is on for this chat' : 'Search the web in this chat'"
		:disabled="disabled"
		:class="[base, !web && off]"
		@click="web = !web"
	>
		<span class="max-sm:hidden">Web</span>
	</Button>
	<Button
		:variant="research ? 'subtle' : 'ghost'"
		:theme="research ? 'blue' : 'gray'"
		size="sm"
		icon-left="lucide-telescope"
		data-slot="research-toggle"
		:aria-pressed="research"
		aria-label="Deep research"
		:title="research ? 'Deep research is on for your next message' : 'Deep research for your next message: many searches, up to a minute, more credits'"
		:disabled="disabled"
		:class="[base, !research && off]"
		@click="research = !research"
	>
		<span class="max-sm:hidden">Research</span>
	</Button>
</template>
