<script setup lang="ts">
import { computed, ref } from "vue";
import { count } from "../numbers";
import { DOCUMENT_TYPES } from "./documents";
import { useFileDrop } from "./file-drop";
import type { SetupStep } from "./onboarding";
import type { WorkspaceDetail } from "./store";
import { pickedFiles } from "./upload";

/**
 * "Set up <name>": the steps a new workspace needs, for a person who can edit it, where their
 * chats will be (WorkspaceOnboarding.vue). Each row is one button that opens what the side
 * panel opens: the instructions dialog, the file picker, Share. A step ticks itself once it is
 * done, and says what was done. Files picked or dropped on the steps go to `upload`, which
 * WorkspaceOnboarding.vue does, with `uploading`; it shows the files the server refused. There is nothing to close: the
 * steps go once the person has a chat here.
 */
const props = defineProps<{ workspace: WorkspaceDetail; steps: SetupStep[]; uploading: number }>();
const emit = defineEmits<{ instructions: []; share: []; upload: [files: File[]] }>();

const done = computed(() => props.steps.filter((step) => step.done).length);
const picker = ref<HTMLInputElement>();
const drop = useFileDrop(
	() => props.steps.some((step) => step.key === "documents"),
	(files) => emit("upload", files),
);

function act(step: SetupStep) {
	if (step.key === "instructions") emit("instructions");
	else if (step.key === "documents") picker.value?.click();
	else emit("share");
}

function picked(event: Event) {
	const files = pickedFiles(event);
	if (files.length) emit("upload", files);
}

/** The word at the end of a row: Uploading while files go up, else the step's own. */
function actionLabel(step: SetupStep) {
	return step.key === "documents" && props.uploading ? "Uploading…" : step.action.label;
}
</script>

<template>
	<section class="space-y-3" aria-labelledby="workspace-setup-heading" data-slot="workspace-setup" v-on="drop.listeners">
		<div class="flex h-7 items-center justify-between gap-3">
			<h2 id="workspace-setup-heading" class="min-w-0 truncate text-base-semibold text-ink-gray-9">Set up {{ workspace.name }}</h2>
			<p class="shrink-0 text-sm tabular-nums text-ink-gray-6" data-slot="workspace-setup-count" :aria-label="`${count(done)} of ${count(steps.length)} steps done`">
				{{ count(done) }} of {{ count(steps.length) }}
			</p>
		</div>

		<ol class="divide-y divide-outline-gray-1 overflow-hidden rounded-7 border border-outline-gray-2">
			<li v-for="step in steps" :key="step.key" class="relative" data-slot="workspace-setup-step" :data-step="step.key" :data-done="step.done || undefined">
				<button
					type="button"
					class="group flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 ease-out-strong hover:bg-surface-gray-1 active:bg-surface-gray-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-outline-gray-3 motion-reduce:transition-none"
					:aria-label="step.action.name"
					:aria-describedby="`workspace-setup-${step.key}`"
					:aria-busy="(step.key === 'documents' && uploading > 0) || undefined"
					@click="act(step)"
				>
					<!-- The step's mark: a ring while it is to do; a check that grows in when it is done. -->
					<span class="relative flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
						<span class="absolute inset-0 rounded-full border-[1.5px] border-outline-gray-3" />
						<Transition enter-from-class="scale-50 opacity-0" enter-active-class="transition-[transform,opacity] duration-200 ease-out-strong motion-reduce:transition-none">
							<span v-if="step.done" class="absolute inset-0 flex items-center justify-center rounded-full bg-surface-gray-8 text-ink-base" data-slot="workspace-setup-check">
								<span class="lucide-check size-3.5" />
							</span>
						</Transition>
					</span>
					<span :id="`workspace-setup-${step.key}`" class="min-w-0 flex-1">
						<span class="block text-base-medium text-ink-gray-8">{{ step.title }}</span>
						<span class="block truncate text-sm text-ink-gray-6"><span v-if="step.done" class="sr-only">Done: </span>{{ step.detail }}</span>
					</span>
					<!-- What the row does, drawn as a button while the step is to do, and quieter once it is done. -->
					<span
						class="flex h-7 shrink-0 items-center gap-1.5 rounded-4 px-2.5 text-sm transition-colors duration-150 ease-out-strong motion-reduce:transition-none"
						:class="step.done ? 'text-ink-gray-6 group-hover:text-ink-gray-8' : 'bg-surface-gray-2 text-ink-gray-8 group-hover:bg-surface-gray-3'"
						aria-hidden="true"
					>
						<span v-if="step.key === 'documents' && uploading" class="lucide-loader-circle size-3.5 animate-spin motion-reduce:animate-none" />
						{{ actionLabel(step) }}
					</span>
				</button>
				<div
					v-if="step.key === 'documents' && drop.active.value"
					class="pointer-events-none absolute inset-0 flex items-center gap-2 bg-surface-gray-2 px-4 text-base text-ink-gray-8"
					data-slot="document-drop"
					aria-hidden="true"
				>
					<span class="lucide-upload size-4 shrink-0" />Drop to upload
				</div>
			</li>
		</ol>
		<input ref="picker" type="file" class="hidden" multiple :accept="DOCUMENT_TYPES" aria-label="Upload documents" data-slot="document-picker" @change="picked" />

		<p class="flex items-center gap-1.5 pt-1 text-sm text-ink-gray-6">
			Or ask a question below to start.
			<span class="lucide-arrow-down size-3.5 shrink-0" aria-hidden="true" />
		</p>
	</section>
</template>
