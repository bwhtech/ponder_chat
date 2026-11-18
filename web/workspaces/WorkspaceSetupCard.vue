<script setup lang="ts">
import { Button, LoadingIndicator } from "frappe-ui";
import { computed } from "vue";
import type { SetupStep } from "./onboarding";
import WorkspaceSetupArt from "./WorkspaceSetupArt.vue";

/**
 * One setup step to do (WorkspaceSetup.vue): its scene, its title, what it is for, and what
 * does it. As a card, with a button under its text. `compact`, on a narrow column: a row, its
 * scene in a small tile, and the whole row is the button, named for what it does ("Add
 * instructions"), with the line under the title as its description. `busy` while the files
 * picked from it go up. `dropping` while files are dragged over the setup: a dashed outline
 * over the scene, and the button says "Drop to upload".
 */
const props = defineProps<{ step: SetupStep; busy?: boolean; dropping?: boolean; compact?: boolean }>();
const emit = defineEmits<{ act: [] }>();

const label = computed(() => (props.busy ? "Uploading…" : props.dropping ? "Drop to upload" : props.step.action));
const titleId = computed(() => `workspace-setup-${props.step.key}`);
const descriptionId = computed(() => `workspace-setup-${props.step.key}-description`);
</script>

<template>
	<article
		class="group relative flex rounded-6 border border-outline-gray-1 bg-surface-base p-2 shadow-sm dark:border-outline-gray-2"
		:class="compact ? 'items-center gap-3 pe-3 transition-colors duration-150 ease-out-strong has-[button:active]:bg-surface-gray-1' : 'flex-col'"
		:aria-labelledby="titleId"
		data-slot="workspace-setup-step"
		:data-step="step.key"
	>
		<div class="relative shrink-0">
			<WorkspaceSetupArt :kind="step.key" :compact="compact" />
			<Transition
				enter-from-class="opacity-0"
				enter-active-class="transition-opacity duration-[120ms] ease-out-strong"
				leave-to-class="opacity-0"
				leave-active-class="transition-opacity duration-[120ms] ease-out-strong"
			>
				<div
					v-if="dropping"
					class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-4 border border-dashed border-outline-gray-4 bg-surface-gray-2 text-ink-gray-7"
					data-slot="document-drop"
					aria-hidden="true"
				>
					<span class="lucide-upload" :class="compact ? 'size-4' : 'size-5'" />
				</div>
			</Transition>
		</div>

		<template v-if="compact">
			<div class="min-w-0 flex-1">
				<h3 :id="titleId" class="text-base font-medium text-ink-gray-9">{{ step.title }}</h3>
				<p :id="descriptionId" class="mt-0.5 text-p-sm text-ink-gray-6">{{ busy || dropping ? label : step.description }}</p>
			</div>
			<LoadingIndicator v-if="busy" class="size-4 shrink-0 text-ink-gray-5" />
			<span v-else class="lucide-chevron-right size-4 shrink-0 text-ink-gray-4" aria-hidden="true" />
			<!-- Over the whole row: the row is the button. -->
			<button
				type="button"
				class="absolute inset-0 rounded-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-outline-gray-3"
				:aria-label="step.action"
				:aria-describedby="descriptionId"
				:disabled="busy"
				@click="emit('act')"
			/>
		</template>
		<div v-else class="flex flex-1 flex-col px-2 pb-2 pt-3">
			<h3 :id="titleId" class="text-base font-medium text-ink-gray-9">{{ step.title }}</h3>
			<p class="mt-1 text-p-sm text-ink-gray-6">{{ step.description }}</p>
			<div class="mt-auto pt-4">
				<Button :label="label" :loading="busy" class="touch-target" @click="emit('act')" />
			</div>
		</div>
	</article>
</template>
