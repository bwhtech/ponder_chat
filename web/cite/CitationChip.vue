<script setup lang="ts">
import { Button, Popover } from "frappe-ui";
import { computed } from "vue";
import { CITATION_MAX_COMMENT, citationLabel, type Citation } from "./citations";
import CommentEditor from "./CommentEditor.vue";

/** Something the comment editor can sit against: the quoted text in the reply. */
export type CiteAnchor = { getBoundingClientRect: () => DOMRect; contextElement?: Element };

/**
 * A quote from an earlier reply. In the message box (`composer`) its label scrolls to
 * the quote, the pencil opens the comment editor, and the cross takes it out. On a sent
 * message, a click opens a card with the quote, the comment, and Go to source.
 */
const props = defineProps<{ citation: Citation; composer?: boolean; editing?: boolean; anchor?: CiteAnchor | null }>();
const emit = defineEmits<{ reveal: []; edit: []; remove: []; save: [comment: string]; send: [comment: string]; cancel: [] }>();

const label = computed(() => citationLabel(props.citation));
// What the editor holds. A click outside saves it only when it changed, like T3 Code
// (assistantCitationCommentDismissal.ts); otherwise the click away counts as Cancel.
let draft: string | null = null;

function onEditorOpen(open: boolean) {
	if (open || !props.editing) return;
	// Too long to save: the editor stays open and says so.
	if (draft !== null && draft.length > CITATION_MAX_COMMENT) return;
	const changed = draft !== null && draft.trim() !== (props.citation.comment ?? "").trim();
	if (changed) emit("save", draft!);
	else emit("cancel");
	draft = null;
}

function finish(event: "save" | "send" | "cancel", comment?: string) {
	draft = null;
	if (event === "cancel") emit("cancel");
	else if (event === "send") emit("send", comment ?? "");
	else emit("save", comment ?? "");
}

/**
 * Go to source: the card closes first. Closing hands focus back to the chip, and that
 * scrolls the chip into view, so the jump to the quote waits for it (or 400 ms at most).
 */
function goToSource(close: () => void) {
	let done = false;
	const reveal = () => {
		if (done) return;
		done = true;
		document.removeEventListener("focusin", reveal, true);
		requestAnimationFrame(() => emit("reveal"));
	};
	document.addEventListener("focusin", reveal, true);
	setTimeout(reveal, 400);
	close();
}
</script>

<template>
	<Popover
		v-if="composer"
		:open="editing"
		trigger="manual"
		bare
		:reference="(anchor ?? undefined) as unknown as Element"
		:side="anchor ? 'bottom' : 'top'"
		align="start"
		:offset="6"
		@update:open="onEditorOpen"
	>
		<template #trigger>
			<span data-slot="citation-chip" class="inline-flex h-6 min-w-0 max-w-full items-center gap-0.5 rounded-full bg-surface-blue-1 pl-2 pr-1 text-sm text-ink-blue-7 dark:bg-surface-blue-2">
				<button
					type="button"
					class="flex min-w-0 items-center gap-1 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-current"
					:aria-label="`Show the quoted text: ${label}`"
					@click="emit('reveal')"
				>
					<span class="lucide-quote size-3.5 shrink-0" aria-hidden="true" />
					<span class="max-w-[16em] truncate">{{ label }}</span>
				</button>
				<button
					type="button"
					class="touch-target ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-surface-blue-2 dark:hover:bg-surface-blue-3"
					:aria-label="citation.comment ? 'Edit the comment' : 'Add a comment'"
					@click="emit('edit')"
				>
					<span class="lucide-pencil size-3" aria-hidden="true" />
				</button>
				<button
					type="button"
					class="touch-target flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-surface-blue-2 dark:hover:bg-surface-blue-3"
					:aria-label="`Remove the quote: ${label}`"
					@click="emit('remove')"
				>
					<span class="lucide-x size-3" aria-hidden="true" />
				</button>
			</span>
		</template>
		<div class="rounded-6 bg-surface-elevation-2 shadow-xl ring-1 ring-outline-gray-2">
			<CommentEditor
				v-if="editing"
				:comment="citation.comment"
				@update:draft="draft = $event"
				@save="finish('save', $event)"
				@send="finish('send', $event)"
				@cancel="finish('cancel')"
			/>
		</div>
	</Popover>

	<Popover v-else side="top" align="end" :offset="6">
		<template #trigger>
			<button
				type="button"
				data-slot="citation-chip"
				class="inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-full bg-surface-blue-1 pl-2 pr-2.5 text-sm text-ink-blue-7 hover:bg-surface-blue-2 dark:bg-surface-blue-2 dark:hover:bg-surface-blue-3"
				:aria-label="`Quoted reply text: ${label}`"
			>
				<span class="lucide-quote size-3.5 shrink-0" aria-hidden="true" />
				<span class="max-w-[16em] truncate">{{ label }}</span>
			</button>
		</template>
		<template #default="{ close }">
			<div data-slot="citation-card" class="flex w-96 max-w-[calc(100vw-2rem)] flex-col items-start gap-3 p-1">
				<div class="max-h-64 space-y-3 self-stretch overflow-y-auto whitespace-pre-wrap break-words text-p-sm">
					<blockquote class="border-l-2 border-outline-gray-3 pl-3 text-ink-gray-6">{{ citation.text }}</blockquote>
					<p v-if="citation.comment" class="text-ink-gray-8">{{ citation.comment }}</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					icon-left="lucide-arrow-up-right"
					@click="goToSource(close)"
				>
					Go to source
				</Button>
			</div>
		</template>
	</Popover>
</template>
