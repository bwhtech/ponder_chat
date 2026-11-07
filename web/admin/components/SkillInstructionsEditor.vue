<script setup lang="ts">
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { CodeEditor, CodeEditorContent, CodeKit } from "frappe-ui/code-editor";

/**
 * A skill's instructions in frappe-ui's code editor, highlighted as Markdown, with line
 * numbers. Lines wrap, as instructions are mostly prose.
 */
const body = defineModel<string>({ required: true });

const extensions = [
	CodeKit.configure({
		lineNumbers: {},
		foldGutter: false,
		autocompletion: false,
		placeholder: "Write the steps Ponder follows, as you would brief a new colleague.",
	}),
	EditorView.lineWrapping,
	markdown(),
	// CodeMirror's own selection colour is a light lavender, which in dark mode sits under light
	// text and hides it. A theme token follows light and dark.
	EditorView.theme({
		"& .cm-selectionLayer .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
			background: "var(--surface-blue-3)",
		},
	}),
];
</script>

<template>
	<CodeEditor v-model="body" :extensions="extensions">
		<CodeEditorContent class="skill-file-editor" aria-label="Instructions" />
	</CodeEditor>
</template>

<style scoped>
.skill-file-editor {
	--code-bg: var(--surface-gray-1);
	--code-border: var(--outline-gray-2);
	--code-font-size: 13px;
	--code-padding-y: 12px;
	--code-padding-x: 14px;
	height: 100%;
}
</style>
