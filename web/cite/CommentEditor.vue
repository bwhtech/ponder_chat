<script setup lang="ts">
import { Button } from "frappe-ui";
import { computed, onMounted, ref, watch } from "vue";
import { CITATION_MAX_COMMENT } from "./citations";

/**
 * The comment on a citation. Enter saves, Cmd/Ctrl+Enter saves and sends the message,
 * Shift+Enter starts a new line, Escape cancels. Adapted from T3 Code.
 */
const props = defineProps<{ comment?: string }>();
const emit = defineEmits<{ save: [comment: string]; send: [comment: string]; cancel: []; "update:draft": [comment: string] }>();

const draft = ref(props.comment ?? "");
watch(draft, (value) => emit("update:draft", value));
const tooLong = computed(() => draft.value.length > CITATION_MAX_COMMENT);
const field = ref<HTMLTextAreaElement | null>(null);
onMounted(() => field.value?.focus({ preventScroll: true }));

function onKeydown(event: KeyboardEvent) {
	if (event.isComposing || event.keyCode === 229) return;
	if (event.key === "Escape") {
		event.preventDefault();
		emit("cancel");
		return;
	}
	if (event.key !== "Enter" || event.shiftKey) return;
	event.preventDefault();
	if (tooLong.value) return;
	if (event.metaKey || event.ctrlKey) emit("send", draft.value);
	else emit("save", draft.value);
}
</script>

<template>
	<div data-slot="cite-comment-editor" class="w-80 max-w-[calc(100vw-2rem)] p-2" @keydown.stop="onKeydown">
		<textarea
			ref="field"
			v-model="draft"
			aria-label="Comment on the quoted text"
			aria-description="Enter to save; Command or Control+Enter to save and send; Shift+Enter for a new line."
			:aria-invalid="tooLong || undefined"
			placeholder="Add an optional comment…"
			rows="2"
			class="block max-h-40 min-h-16 w-full resize-none border-0 bg-transparent px-1 py-1.5 text-base text-ink-gray-8 placeholder:text-ink-gray-5 focus:ring-0 [field-sizing:content] sm:text-sm"
		/>
		<p v-if="tooLong" role="status" class="px-1 pt-1 text-xs text-ink-red-6">Comments can have up to {{ CITATION_MAX_COMMENT.toLocaleString() }} characters.</p>
		<div class="mt-2 flex items-center justify-end gap-2">
			<Button variant="outline" size="sm" @pointerdown.prevent @click="emit('cancel')">Cancel</Button>
			<Button variant="solid" size="sm" :disabled="tooLong" @pointerdown.prevent @click="emit('save', draft)">Save</Button>
		</div>
	</div>
</template>
