<script setup lang="ts">
import { useId } from "vue";
import WorkspaceIntroArt from "./WorkspaceIntroArt.vue";

/**
 * The sidebar's workspaces while the person has none (WorkspaceRows.vue): a card, as the
 * setup cards on a new workspace's page are (WorkspaceSetupCard.vue). Its scene, the section's
 * title (the sidebar's "Workspaces" label is not shown with it), what a workspace is for, and New workspace, whose click area covers the card. The × hides
 * it (intro.ts), and the plain "New workspace" row takes its place.
 *
 * No frappe-ui code, so that WorkspaceRowsPlaceholder.vue draws the same card while the
 * chats panel loads (`inert`): the button has the classes of frappe-ui's subtle Button.
 */
const emit = defineEmits<{ create: []; hide: [] }>();
const id = useId();
</script>

<template>
	<article
		class="group relative rounded-6 border border-outline-gray-1 bg-surface-base p-[7px] shadow-sm transition-transform duration-150 ease-out-strong has-[[data-slot=workspace-intro-create]:active]:scale-[0.98] motion-reduce:transition-none motion-reduce:has-[[data-slot=workspace-intro-create]:active]:scale-100 dark:border-outline-gray-2"
		:aria-labelledby="`${id}-title`"
		data-slot="workspace-intro"
	>
		<WorkspaceIntroArt />
		<button
			type="button"
			class="absolute right-3 top-3 z-10 flex size-6 items-center justify-center rounded-4 text-ink-gray-5 after:absolute after:-inset-1 after:content-[''] [@media(pointer:coarse)]:after:-inset-2.5 transition-colors duration-150 ease-out-strong hover:bg-surface-gray-3 hover:text-ink-gray-8 active:bg-surface-gray-4"
			aria-label="Hide"
			title="Hide"
			@click="emit('hide')"
		>
			<span class="lucide-x size-4" aria-hidden="true" />
		</button>
		<div class="pb-0.5 pt-3">
			<h3 :id="`${id}-title`" class="text-base font-medium text-ink-gray-9">Workspaces</h3>
			<p :id="`${id}-description`" class="mt-1 text-pretty text-p-sm text-ink-gray-6">An organised place for instructions, a knowledge base and people.</p>
			<!-- Its click area stretches over the card (the card is `relative`, the button is not). -->
			<button
				type="button"
				class="mt-3 inline-flex h-7 shrink-0 items-center justify-center gap-2 rounded-4 bg-surface-gray-2 px-2 text-base text-ink-gray-8 transition-colors after:absolute after:inset-0 after:rounded-6 after:content-[''] hover:bg-surface-gray-3 active:bg-surface-gray-4"
				:aria-describedby="`${id}-description`"
				data-slot="workspace-intro-create"
				@click="emit('create')"
			>
				New workspace
			</button>
		</div>
	</article>
</template>
