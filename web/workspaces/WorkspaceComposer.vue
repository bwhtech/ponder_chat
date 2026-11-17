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

/**
 * The workspace page's message box: a question here starts a new chat in this workspace
 * (Shell.vue hands it to the chat, first-message.ts). The same box as a chat's, with $ for
 * skills; the placeholder names the workspace. What was typed stays per workspace, as a
 * chat's draft does. The $ menu opens under the box, which sits near the top of the page.
 */
const props = defineProps<{ workspaceId: string; name: string }>();
const emit = defineEmits<{ ask: [message: FirstMessage] }>();

const input = ref("");
useDraft(`workspace:${props.workspaceId}`, input);
const model = ref(defaultModel.value);
// The page opened before the list of models came.
watch(defaultModel, (fallback) => !model.value && (model.value = fallback));
const outOfCredits = computed(() => (me.value?.credits.remaining ?? 1) <= 0);
const label = computed(() => (props.name ? `Ask in ${props.name}` : "Ask a question"));
const placeholder = computed(() => withSkillsHint(label.value));

const composer = ref<HTMLElement | null>(null);
const skills = useSkillPicker(input, composer);
const skillQuery = skills.typed;
void loadSkills();

function ask({ text, files }: { text: string; files: File[] }) {
	if (!text && !files.length && !skills.chosen.value.length) return;
	// The chat's code loads as the page changes to it.
	void preloadChat();
	emit("ask", { text, files, skills: skills.take(), model: model.value || defaultModel.value, workspaceId: props.workspaceId });
}
</script>

<template>
	<div class="space-y-2" data-slot="workspace-composer">
		<OutOfCredits v-if="outOfCredits" />
		<div ref="composer" class="relative" v-bind="skills.listeners">
			<SkillMenu
				v-if="skills.open.value && skillQuery"
				below
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
				<PromptInputTextarea :placeholder="placeholder" :aria-label="label" />
				<PromptInputFooter>
					<PromptInputTools>
						<PromptInputAttachButton />
						<ModelSelector v-if="models.length" v-model="model" :models="models" label="Model" />
					</PromptInputTools>
					<PromptInputSubmit />
				</PromptInputFooter>
			</PromptInput>
		</div>
	</div>
</template>
