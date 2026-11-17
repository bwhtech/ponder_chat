<script setup lang="ts">
import { nextTick, ref } from "vue";

/**
 * The workspace page's name. For people who can edit, it is a "Rename" button that turns into
 * a field in the same place: Enter or leaving the field renames, Escape keeps the name, and an
 * empty name is not taken. Everyone else sees plain text. The heading keeps the name as its
 * accessible name either way.
 */
const props = defineProps<{ name: string; editable: boolean }>();
const emit = defineEmits<{ rename: [name: string] }>();

const editing = ref(false);
const draft = ref("");
const field = ref<HTMLInputElement>();
const trigger = ref<HTMLButtonElement>();

async function start() {
	draft.value = props.name;
	editing.value = true;
	await nextTick();
	field.value?.select();
}

/** Enter and Escape put focus back on the name; leaving the field leaves it where it went. */
async function finish(save: boolean, refocus = false) {
	if (!editing.value) return;
	editing.value = false;
	const name = draft.value.trim();
	if (save && name && name !== props.name) emit("rename", name);
	if (!refocus) return;
	await nextTick();
	trigger.value?.focus();
}

function onEnter(event: KeyboardEvent) {
	if (!event.isComposing) void finish(true, true);
}
</script>

<template>
	<h1 v-if="!editable" class="min-w-0 flex-1 truncate text-lg-semibold text-ink-gray-9">{{ name }}</h1>
	<!-- The button and the field share one box, pulled out by its border and padding, so the name does not move. -->
	<h1 v-else class="flex min-w-0 flex-1 text-lg-semibold text-ink-gray-9" :aria-label="name" data-slot="workspace-title">
		<!-- The field is as wide as its text, as the button is: a hidden copy of the text sizes it, with 1px more for the caret (size="1" drops the field's own width). -->
		<span v-if="editing" class="-ml-[5px] grid min-w-12 max-w-[calc(100%+5px)]">
			<span class="invisible col-start-1 row-start-1 h-7 min-w-0 overflow-hidden whitespace-pre border pl-1 pr-[5px]" aria-hidden="true">{{ draft }}</span>
			<input
				ref="field"
				v-model="draft"
				type="text"
				size="1"
				maxlength="80"
				aria-label="Workspace name"
				class="col-start-1 row-start-1 h-7 w-full min-w-0 rounded-4 border border-outline-gray-4 bg-surface-base px-1 py-0 text-lg-semibold text-ink-gray-9 shadow-sm outline-none focus:border-outline-gray-4 focus:ring-0"
				@keydown.enter.prevent="onEnter"
				@keydown.esc.prevent.stop="finish(false, true)"
				@blur="finish(true)"
			/>
		</span>
		<button
			v-else
			ref="trigger"
			type="button"
			aria-label="Rename"
			class="relative -ml-[5px] flex h-7 min-w-0 max-w-[calc(100%+5px)] items-center rounded-4 border border-transparent px-1 text-start transition-colors duration-150 ease-out-strong after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] hover:bg-surface-gray-2 focus-visible:bg-surface-gray-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-outline-gray-3 motion-reduce:transition-none"
			@click="start"
		>
			<span class="truncate">{{ name }}</span>
		</button>
	</h1>
</template>
