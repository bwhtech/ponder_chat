<script setup lang="ts">
import { computed } from "vue";
import { CodeBlockContent } from "frappe-ui-ai-elements";
import type { Artifact } from "../side-panel/panel";
import { framedPage, HTML_SANDBOX } from "./html";

/**
 * An HTML artifact in the panel: the running page, or its code. While the reply writes it,
 * the code shows; the page runs once it is finished, so it does not restart on every word.
 * The frame stays when the person looks at the code, so the page keeps its state.
 */
const props = defineProps<{ artifact: Artifact; view: "preview" | "code" }>();

const page = computed(() => (props.artifact.writing ? "" : framedPage(props.artifact.content)));
const showCode = computed(() => props.artifact.writing || props.view === "code");
</script>

<template>
	<div class="flex h-full min-h-0 flex-col">
		<iframe
			v-if="page"
			v-show="!showCode"
			:srcdoc="page"
			:sandbox="HTML_SANDBOX"
			referrerpolicy="no-referrer"
			:title="artifact.title"
			class="min-h-0 w-full flex-1 border-0 bg-white"
		/>
		<!-- data-slot gives the code the highlight colours of code blocks in replies. -->
		<div v-if="showCode" data-slot="code-block" class="min-h-full bg-surface-gray-1 text-sm text-ink-gray-8">
			<CodeBlockContent :code="artifact.content" language="html" class="min-h-full" />
		</div>
	</div>
</template>
