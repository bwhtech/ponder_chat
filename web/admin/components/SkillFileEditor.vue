<script setup lang="ts">
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { EditorView } from "@codemirror/view";
import { CodeEditor, CodeEditorContent, CodeKit } from "frappe-ui/code-editor";

/**
 * A skill file in frappe-ui's code editor: the frontmatter highlighted as YAML and the rest
 * as Markdown, with line numbers. Lines wrap, as skill files are mostly prose.
 */
const source = defineModel<string>({ required: true });

const extensions = [
	CodeKit.configure({ lineNumbers: {}, foldGutter: false, autocompletion: false, placeholder: "---\nname: \ndescription: \n---" }),
	EditorView.lineWrapping,
	yamlFrontmatter({ content: markdown() }),
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
	<CodeEditor v-model="source" :extensions="extensions">
		<CodeEditorContent class="skill-file-editor" aria-label="Skill file" />
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
