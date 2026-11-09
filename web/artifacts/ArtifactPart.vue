<script setup lang="ts">
import { computed, watch } from "vue";
import Shimmer from "../ai-elements/shimmer/Shimmer.vue";
import { getToolPhase, type ToolMessagePart } from "../ai-elements/tool";
import { slideCount } from "./slides";
import { panelItem, viewArtifact, type Artifact } from "../side-panel/panel";

/**
 * A write_artifact call (server/artifacts/schema.ts) as a card in the reply. A click opens
 * the artifact in the side panel. Each call is one version: its card opens that version.
 *
 * A reply that starts writing one opens it in the panel on a wide screen, and the panel
 * follows the new version of an artifact it already shows.
 */
type Input = Partial<{ id: string; kind: "document" | "slides"; title: string; content: string }>;

const props = defineProps<{ part: ToolMessagePart; streaming?: boolean }>();
const key = computed(() => `artifact:${props.part.toolCallId}`);
const phase = computed(() => getToolPhase(props.part.state, { streaming: props.streaming }));
const failed = computed(() => phase.value === "failed" || (phase.value === "stopped" && props.part.state === "input-streaming"));

const artifact = computed<Artifact>(() => {
	const input = (props.part.input ?? {}) as Input;
	return {
		id: input.id ?? "",
		kind: input.kind === "slides" ? "slides" : "document",
		title: input.title?.trim() || "Untitled",
		content: input.content ?? "",
		writing: phase.value === "preparing",
	};
});

const slides = computed(() => artifact.value.kind === "slides");
const isOpen = computed(() => panelItem.value?.key === key.value);
const detail = computed(() => {
	if (failed.value) return "Could not be written";
	const kind = slides.value ? "Slides" : "Document";
	return slides.value ? `${kind} · ${slideCount(artifact.value.content)} slides` : kind;
});

function open() {
	if (!failed.value) viewArtifact(key.value, artifact);
}

// Opens the panel once, when the reply starts writing this version.
watch(
	() => artifact.value.writing && Boolean(artifact.value.id),
	(started) => {
		if (!started || isOpen.value) return;
		const shown = panelItem.value;
		const newVersion = shown?.type === "artifact" && shown.artifact.value.id === artifact.value.id;
		if (newVersion || (!shown && matchMedia("(min-width: 1024px)").matches)) open();
	},
	{ immediate: true },
);
</script>

<template>
	<button
		type="button"
		data-slot="artifact-card"
		:data-open="isOpen || undefined"
		:disabled="failed"
		:aria-label="`Open ${artifact.title}`"
		class="group/artifact my-1.5 flex w-full max-w-sm items-center gap-3 rounded-7 border border-outline-gray-2 bg-surface-base p-2 pr-3 text-left transition-[background-color,border-color,transform] duration-150 ease-out-strong hover:bg-surface-gray-1 active:scale-[0.99] disabled:cursor-default disabled:hover:bg-surface-base data-[open]:border-outline-gray-3 data-[open]:bg-surface-gray-1 motion-reduce:active:scale-100"
		@click="open"
	>
		<span class="flex size-10 shrink-0 items-center justify-center rounded-5 bg-surface-gray-2" aria-hidden="true">
			<span :class="[slides ? 'lucide-presentation text-ink-amber-6' : 'lucide-file-text text-ink-blue-6', 'size-5']" />
		</span>
		<span class="flex min-w-0 flex-1 flex-col gap-1">
			<span class="truncate text-base-medium text-ink-gray-9">{{ artifact.title }}</span>
			<span class="truncate text-sm text-ink-gray-5" :class="{ 'text-ink-red-6': failed }">
				<Shimmer v-if="artifact.writing">Writing {{ slides ? "slides" : "document" }}…</Shimmer>
				<template v-else>{{ detail }}</template>
			</span>
		</span>
		<span
			v-if="!failed"
			class="lucide-panel-right-open size-4 shrink-0 text-ink-gray-5 opacity-0 transition-opacity duration-150 group-hover/artifact:opacity-100 group-data-[open]/artifact:opacity-100 [@media(pointer:coarse)]:opacity-100"
			aria-hidden="true"
		/>
	</button>
</template>
