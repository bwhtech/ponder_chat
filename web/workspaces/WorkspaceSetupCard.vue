<script setup lang="ts">
import { Button } from "frappe-ui";
import type { SetupStep } from "./onboarding";
import WorkspaceSetupArt from "./WorkspaceSetupArt.vue";

/**
 * One setup step to do, as a card (WorkspaceSetup.vue): its scene, its title, what it is for,
 * and one button that does it. `busy` while the files picked from it go up. `dropping` while
 * files are dragged over the setup cards: the Documents card says it takes them.
 */
defineProps<{ step: SetupStep; busy?: boolean; dropping?: boolean }>();
const emit = defineEmits<{ act: [] }>();
</script>

<template>
	<article
		class="group relative flex flex-col rounded-6 border border-outline-gray-1 bg-surface-base p-2 shadow-sm dark:border-outline-gray-2"
		:aria-labelledby="`workspace-setup-${step.key}`"
		data-slot="workspace-setup-step"
		:data-step="step.key"
	>
		<WorkspaceSetupArt :kind="step.key" />
		<div class="flex flex-1 flex-col px-2 pb-2 pt-3">
			<h3 :id="`workspace-setup-${step.key}`" class="text-base-semibold text-ink-gray-9">{{ step.title }}</h3>
			<p class="mt-1 text-p-sm text-ink-gray-6">{{ step.description }}</p>
			<div class="mt-auto pt-4">
				<Button :label="busy ? 'Uploading…' : step.action" :loading="busy" class="touch-target" @click="emit('act')" />
			</div>
		</div>
		<div
			v-if="dropping"
			class="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-6 border border-outline-gray-3 bg-surface-gray-2 text-base text-ink-gray-8"
			data-slot="document-drop"
			aria-hidden="true"
		>
			<span class="lucide-upload size-5" />Drop to upload
		</div>
	</article>
</template>
