<script setup lang="ts">
import { PromptInput, PromptInputAttachButton, PromptInputFooter, PromptInputHeader, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from "frappe-ui-ai-elements";
import { computed, ref, watch } from "vue";
import { me } from "../account";
import { useDraft } from "../drafts";
import { OutOfCredits } from "../lazy-alert";
import { acceptedFiles, defaultModel, ModelSelector, models } from "../models";
import { preloadChat } from "../preload";
import type { FirstMessage } from "./first-message";
import WorkspaceChip from "./WorkspaceChip.vue";
import { workspaceById } from "./store";

/**
 * The workspace page's message box: a question here starts a new chat in this workspace
 * (Shell.vue hands it to the chat, first-message.ts). The same box as a chat's, with the
 * workspace fixed. What was typed stays per workspace, as a chat's draft does.
 */
const props = defineProps<{ workspaceId: string; name: string }>();
const emit = defineEmits<{ ask: [message: FirstMessage] }>();

const input = ref("");
useDraft(`workspace:${props.workspaceId}`, input);
const model = ref(defaultModel.value);
// The page opened before the list of models came.
watch(defaultModel, (fallback) => !model.value && (model.value = fallback));
const outOfCredits = computed(() => (me.value?.credits.remaining ?? 1) <= 0);
const workspace = computed(() => workspaceById(props.workspaceId));
const placeholder = computed(() => (props.name ? `Ask in ${props.name}` : "Ask a question"));

function ask({ text, files }: { text: string; files: File[] }) {
	if (!text && !files.length) return;
	// The chat's code loads as the page changes to it.
	void preloadChat();
	emit("ask", { text, files, model: model.value || defaultModel.value, workspaceId: props.workspaceId });
}
</script>

<template>
	<div class="space-y-2" data-slot="workspace-composer">
		<OutOfCredits v-if="outOfCredits" />
		<PromptInput v-model="input" :disabled="outOfCredits" :accept="acceptedFiles" @submit="ask">
			<PromptInputHeader />
			<PromptInputTextarea :placeholder="placeholder" :aria-label="placeholder" />
			<PromptInputFooter>
				<PromptInputTools>
					<PromptInputAttachButton />
					<ModelSelector v-if="models.length" v-model="model" :models="models" label="Model" />
					<WorkspaceChip v-if="workspace" :workspace="workspace" locked />
				</PromptInputTools>
				<PromptInputSubmit />
			</PromptInputFooter>
		</PromptInput>
	</div>
</template>
