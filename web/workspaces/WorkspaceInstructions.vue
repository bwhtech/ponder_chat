<script setup lang="ts">
import { Button } from "frappe-ui";
import { ref, watch } from "vue";
import { loadMarkdown, Markdown } from "../markdown";
import { setupStep } from "./onboarding";
import WorkspaceSetupCard from "./WorkspaceSetupCard.vue";

/**
 * The instructions every chat in the workspace follows, on its page, drawn as Markdown,
 * as replies are. For a person who can edit, empty ones are the setup card's ("Add instructions"), and
 * filled ones show their first three lines in a box that opens the instructions dialog: a
 * pencil shows in its corner on hover, and always on touch. A person who can only ask reads
 * them whole: past a length, behind "Show all". Until the Markdown renderer is here
 * (markdown.ts), the text shows as it is.
 */
/** `compact`: the empty card is a row, in a one-column page (WorkspaceAbout.vue). */
const props = defineProps<{ instructions: string; editable: boolean; compact?: boolean }>();
const emit = defineEmits<{ edit: [] }>();

const LONG = 600;
const ADD = setupStep("instructions");
const expanded = ref(false);

watch(
	() => Boolean(props.instructions),
	(filled) => filled && void loadMarkdown().catch(() => undefined),
	{ immediate: true },
);
</script>

<template>
	<section class="space-y-3" aria-labelledby="workspace-instructions-heading">
		<div class="flex h-7 items-center">
			<h2 id="workspace-instructions-heading" class="text-base-semibold text-ink-gray-9">Instructions</h2>
		</div>
		<WorkspaceSetupCard v-if="!instructions" :step="ADD" untitled :compact="compact" data-slot="workspace-add-instructions" @act="emit('edit')" />
		<!-- The whole box is the Edit button. The text under it is inert: its links, copy buttons and tables take no
		     focus and no click, so Tab and Enter reach only the button. A screen reader reads the text as the button's description. -->
		<div v-else-if="editable" class="group relative">
			<div
				id="workspace-instructions-preview"
				inert
				data-slot="workspace-instructions"
				class="break-words rounded-4 bg-surface-gray-2 px-3 py-2 text-p-sm text-ink-gray-8 transition-colors duration-150 ease-out-strong group-hover:bg-surface-gray-3 motion-reduce:transition-none"
			>
				<!-- Clamped inside the padding: a clamp on the padded box clips at its outer edge, so a list item's
				     wrapped line could show the start of a fourth line in the bottom padding. -->
				<div class="line-clamp-3">
					<component :is="Markdown" v-if="Markdown" :content="instructions" size="sm" :parse-incomplete="false" />
					<p v-else class="whitespace-pre-wrap">{{ instructions }}</p>
				</div>
			</div>
			<button
				type="button"
				aria-label="Edit instructions"
				aria-describedby="workspace-instructions-preview"
				data-slot="workspace-edit-instructions"
				class="absolute inset-0 rounded-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-outline-gray-3"
				@click="emit('edit')"
			>
				<span
					class="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-3 border border-outline-gray-1 bg-[color-mix(in_srgb,var(--surface-elevation-1)_70%,transparent)] text-ink-gray-7 opacity-0 shadow-sm backdrop-blur-sm transition-opacity duration-150 ease-out-strong group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
					aria-hidden="true"
				>
					<span class="lucide-pencil size-4" />
				</span>
			</button>
		</div>
		<template v-else>
			<div data-slot="workspace-instructions" class="break-words text-p-sm text-ink-gray-8" :class="{ 'line-clamp-[12]': !expanded && instructions.length > LONG }">
				<component :is="Markdown" v-if="Markdown" :content="instructions" size="sm" :parse-incomplete="false" />
				<p v-else class="whitespace-pre-wrap">{{ instructions }}</p>
			</div>
			<Button v-if="instructions.length > LONG" variant="ghost" size="sm" class="touch-target -ml-2" :label="expanded ? 'Show less' : 'Show all'" @click="expanded = !expanded" />
		</template>
	</section>
</template>
