<script setup lang="ts">
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { CodeEditor, CodeEditorContent, CodeKit, type CodeEditorExposed } from "frappe-ui/code-editor";
import { nextTick, onMounted, useTemplateRef } from "vue";

/**
 * Instructions in frappe-ui's code editor, highlighted as Markdown, with line numbers. Lines
 * wrap, as instructions are mostly prose. A skill's instructions use it in /admin
 * (SkillEdit.vue), and a workspace's in the chat (WorkspaceInstructionsDialog.vue), which
 * loads it with its dialog, as CodeMirror is too large for the first page.
 *
 * `label` names the field for screen readers. With `autofocus`, the editor takes the focus
 * when it mounts, with the caret at the end, so the first key adds to the text.
 */
const props = withDefaults(defineProps<{ placeholder: string; label?: string; autofocus?: boolean }>(), { label: "Instructions", autofocus: false });
const body = defineModel<string>({ required: true });
const code = useTemplateRef<CodeEditorExposed>("code");

const extensions = [
	CodeKit.configure({
		lineNumbers: {},
		foldGutter: false,
		autocompletion: false,
		placeholder: props.placeholder,
	}),
	EditorView.lineWrapping,
	EditorView.contentAttributes.of({ "aria-label": props.label }),
	markdown(),
	// CodeMirror's own selection colour is a light lavender, which in dark mode sits under light
	// text and hides it. A theme token follows light and dark.
	EditorView.theme({
		"& .cm-selectionLayer .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
			background: "var(--surface-blue-3)",
		},
	}),
];

// After a tick and a frame, as frappe-ui's Dialog focuses its field then too, so this comes last.
onMounted(() => {
	if (!props.autofocus) return;
	void nextTick(() =>
		requestAnimationFrame(() => {
			const view = code.value?.editor;
			if (!view) return;
			view.focus();
			view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
		}),
	);
});
</script>

<template>
	<CodeEditor ref="code" v-model="body" :extensions="extensions">
		<CodeEditorContent class="markdown-editor" />
	</CodeEditor>
</template>

<style scoped>
.markdown-editor {
	--code-bg: var(--surface-gray-1);
	--code-border: var(--outline-gray-2);
	--code-font-size: 13px;
	--code-padding-y: 12px;
	--code-padding-x: 14px;
	height: 100%;
}
</style>
