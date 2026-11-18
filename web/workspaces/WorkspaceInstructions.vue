<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { ref, watch } from "vue";
import { loadMarkdown, Markdown } from "../markdown";
import WorkspaceEmptyArea from "./WorkspaceEmptyArea.vue";

/**
 * The instructions every chat in the workspace follows, in its side panel, drawn as Markdown,
 * as replies are. For a person who can edit, empty ones are an "Add instructions" area, and
 * filled ones show their first three lines in a box that opens the instructions dialog: a
 * pencil shows in its corner on hover, and always on touch. A person who can only ask reads
 * them whole: past a length, behind "Show all". `instructions` is undefined while the
 * workspace loads. Until the Markdown renderer is here (markdown.ts), the text shows as it is.
 */
const props = defineProps<{ instructions?: string; editable: boolean }>();
const emit = defineEmits<{ edit: [] }>();

const LONG = 600;
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
		<div v-if="instructions === undefined" aria-busy="true">
			<div v-for="width in ['w-full', 'w-11/12', 'w-2/3']" :key="width" class="flex h-[1lh] items-center text-p-sm"><Skeleton :class="['h-3 rounded-4', width]" /></div>
		</div>
		<WorkspaceEmptyArea v-else-if="!instructions" icon="lucide-plus" label="Add instructions" data-slot="workspace-add-instructions" @click="emit('edit')" />
		<!-- The whole box is the Edit button. The text under it is inert: its links, copy buttons and tables take no
		     focus and no click, so Tab and Enter reach only the button. A screen reader reads the text as the button's description. -->
		<div v-else-if="editable" class="group relative">
			<div
				id="workspace-instructions-preview"
				inert
				data-slot="workspace-instructions"
				class="line-clamp-3 break-words rounded-4 bg-surface-gray-2 px-3 py-2 text-p-sm text-ink-gray-8 transition-colors duration-150 ease-out-strong group-hover:bg-surface-gray-3 motion-reduce:transition-none"
			>
				<component :is="Markdown" v-if="Markdown" :content="instructions" size="sm" :parse-incomplete="false" />
				<p v-else class="whitespace-pre-wrap">{{ instructions }}</p>
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
