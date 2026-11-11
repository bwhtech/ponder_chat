<script setup lang="ts">
import { ScrollArea } from "frappe-ui";

/**
 * frappe-ui's SettingsBody, with 1rem side padding on phones (PanelHeader.vue), and the
 * edges fading while content scrolls under the header or past the bottom (scroll-fade-y,
 * in frappe-ui-ai-elements/styles.css). SettingsBody has no way to add a class to its viewport.
 */
</script>

<template>
	<ScrollArea class="min-h-0 flex-1" viewport-class="scroll-fade-y px-4 pb-16 sm:px-12">
		<slot />
	</ScrollArea>
</template>
