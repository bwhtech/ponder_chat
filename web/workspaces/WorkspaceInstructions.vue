<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { ref } from "vue";
import WorkspaceEmptyArea from "./WorkspaceEmptyArea.vue";

/**
 * The instructions every chat in the workspace follows, in its side panel. For a person who
 * can edit, empty ones are an "Add instructions" area, and filled ones show their first three
 * lines, with Edit by the heading; the area, the lines and Edit all open the instructions
 * dialog. A person who can only ask reads them whole: past a length, behind "Show all".
 * `instructions` is undefined while the workspace loads.
 */
defineProps<{ instructions?: string; editable: boolean }>();
const emit = defineEmits<{ edit: [] }>();

const LONG = 600;
const expanded = ref(false);
</script>

<template>
	<section class="space-y-3" aria-labelledby="workspace-instructions-heading">
		<div class="flex h-7 items-center justify-between">
			<h2 id="workspace-instructions-heading" class="text-base-semibold text-ink-gray-9">Instructions</h2>
			<Button
				v-if="editable && instructions"
				variant="ghost"
				icon-left="lucide-pencil"
				label="Edit"
				class="touch-target -mr-2"
				data-slot="workspace-edit-instructions"
				@click="emit('edit')"
			/>
		</div>
		<div v-if="instructions === undefined" aria-busy="true">
			<div v-for="width in ['w-full', 'w-11/12', 'w-2/3']" :key="width" class="flex h-[1lh] items-center text-p-sm"><Skeleton :class="['h-3 rounded-4', width]" /></div>
		</div>
		<WorkspaceEmptyArea v-else-if="!instructions" icon="lucide-plus" label="Add instructions" data-slot="workspace-add-instructions" @click="emit('edit')" />
		<!-- A second, larger way to Edit for the pointer; Edit is the one for the keyboard. Its background reaches past the text, as on the rows. -->
		<div
			v-else-if="editable"
			class="relative isolate cursor-pointer before:absolute before:-inset-x-2 before:-inset-y-1 before:-z-10 before:rounded-4 before:transition-colors before:duration-150 before:content-[''] before:[transition-timing-function:var(--ease-out-strong)] hover:before:bg-surface-gray-2 active:before:bg-surface-gray-3 motion-reduce:before:transition-none"
			@click="emit('edit')"
		>
			<p data-slot="workspace-instructions" class="line-clamp-3 whitespace-pre-wrap break-words text-p-sm text-ink-gray-8">{{ instructions }}</p>
		</div>
		<template v-else>
			<p data-slot="workspace-instructions" class="whitespace-pre-wrap break-words text-p-sm text-ink-gray-8" :class="{ 'line-clamp-[12]': !expanded && instructions.length > LONG }">{{ instructions }}</p>
			<Button v-if="instructions.length > LONG" variant="ghost" size="sm" class="-ml-2" :label="expanded ? 'Show less' : 'Show all'" @click="expanded = !expanded" />
		</template>
	</section>
</template>
