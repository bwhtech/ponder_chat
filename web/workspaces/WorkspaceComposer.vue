<script setup lang="ts">
import { PromptInput, PromptInputAttachButton, PromptInputFooter, PromptInputHeader, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from "frappe-ui-ai-elements";
import { computed, ref, watch } from "vue";
import { me } from "../account";
import { useDraft } from "../drafts";
import { OutOfCredits } from "../lazy-alert";
import { acceptedFiles, defaultModel, ModelSelector, models } from "../models";
import { preloadChat } from "../preload";
import { SkillMenu, useSkillPicker } from "../skills/picker";
import { loadSkills, withSkillsHint } from "../skills/skills";
import { SkillChip } from "../transcript-parts";
import type { FirstMessage } from "./first-message";
import type { ComposerHandle } from "./handles";
import { useWebTools } from "../web-tools";
import WebTools from "../WebTools.vue";

/**
 * The workspace page's message box: a question here starts a new chat in this workspace
 * (Shell.vue hands it to the chat, first-message.ts). The same box as a chat's, with $ for
 * skills; the placeholder names the workspace. What was typed stays per workspace, as a
 * chat's draft does. Web starts off, so the chat answers from the workspace's Sources (web-tools.ts). The box floats at the bottom of the page, where the chat's own box is, so
 * the $ menu opens above it, as in a chat.
 */
const props = defineProps<{ workspaceId: string; name: string }>();
const emit = defineEmits<{ ask: [message: FirstMessage] }>();

const input = ref("");
useDraft(`workspace:${props.workspaceId}`, input);
// Typing a question: the chat's code loads now, as in a chat, so the chat it opens shows the question at once.
watch(input, () => void preloadChat(), { once: true });
const model = ref(defaultModel.value);
// The page opened before the list of models came.
watch(defaultModel, (fallback) => !model.value && (model.value = fallback));
const outOfCredits = computed(() => (me.value?.credits.remaining ?? 1) <= 0);
const { web, research, take: takeWeb } = useWebTools(() => true);
const label = computed(() => (props.name ? `Ask in ${props.name}` : "Ask a question"));
const placeholder = computed(() => (research.value ? "Ask a research question" : withSkillsHint(label.value)));

const composer = ref<HTMLElement | null>(null);
const field = ref<ComposerHandle>();
defineExpose<ComposerHandle>({ focus: () => field.value?.focus() });
const skills = useSkillPicker(input, composer);
const skillQuery = skills.typed;
void loadSkills();

function ask({ text, files }: { text: string; files: File[] }) {
	if (!text && !files.length && !skills.chosen.value.length) return;
	// The chat's code loads as the page changes to it.
	void preloadChat();
	// Where the box is now, before the page changes: the chat's box slides from here.
	const box = composer.value?.getBoundingClientRect();
	const from = box && { left: box.left, bottom: box.bottom };
	emit("ask", { text, files, skills: skills.take(), model: model.value || defaultModel.value, workspaceId: props.workspaceId, web: takeWeb(), from });
}
</script>

<template>
	<div class="space-y-2" data-slot="workspace-composer">
		<OutOfCredits v-if="outOfCredits" />
		<div ref="composer" class="relative" v-bind="skills.listeners">
			<SkillMenu
				v-if="skills.open.value && skillQuery"
				:items="skills.matches.value"
				:query="skillQuery.query"
				:active="skills.active.value"
				@choose="skills.choose"
				@hover="(index) => (skills.active.value = index)"
			/>
			<PromptInput v-model="input" :disabled="outOfCredits" :accept="acceptedFiles" :ready="skills.chosen.value.length > 0" @submit="ask">
				<PromptInputHeader />
				<div v-if="skills.chosen.value.length" data-slot="prompt-input-skills" class="flex flex-wrap gap-1.5 px-3 pt-3 [@media(pointer:coarse)]:gap-y-5">
					<SkillChip v-for="skill in skills.chosen.value" :key="skill" :name="skill" removable @remove="skills.remove(skill)" />
				</div>
				<!-- Keyed: the field sets its height from its text and placeholder when it mounts, and a rename changes the placeholder. -->
				<PromptInputTextarea ref="field" :key="placeholder" :placeholder="placeholder" :aria-label="label" />
				<PromptInputFooter>
					<PromptInputTools>
						<PromptInputAttachButton />
						<WebTools v-model:web="web" v-model:research="research" in-workspace :disabled="outOfCredits" />
						<ModelSelector v-if="models.length" v-model="model" :models="models" label="Model" />
					</PromptInputTools>
					<PromptInputSubmit />
				</PromptInputFooter>
			</PromptInput>
		</div>
	</div>
</template>
