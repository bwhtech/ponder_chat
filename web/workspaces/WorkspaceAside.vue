<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { computed, ref } from "vue";
import type { WorkspaceDocument } from "./documents";
import { canEdit, canShare, kindIcon, people, type Member, type WorkspaceDetail, type WorkspaceSummary } from "./store";
import WorkspaceDocuments from "./WorkspaceDocuments.vue";

/**
 * The workspace page's side panel: the instructions that every chat here follows, its
 * documents, and who can use it. Beside the chats on a wide screen, under them on a phone. While the workspace
 * loads, the headings and their buttons stay, and skeleton lines stand in for the values.
 */
const props = defineProps<{ workspace?: WorkspaceSummary; detail?: WorkspaceDetail }>();
const emit = defineEmits<{ edit: []; share: []; documents: [documents: WorkspaceDocument[]] }>();

/** Long instructions show their first lines until asked for all. */
const LONG = 600;
const expanded = ref(false);
const instructions = computed(() => props.detail?.instructions.trim() ?? "");

const accessNote = computed(() => {
	const detail = props.detail;
	if (!detail) return "";
	if (detail.kind === "org") return "Everyone in the organisation can ask in it. Admins edit it.";
	if (detail.access === "owner") return detail.memberCount ? "Only the people here can use it." : "Only you can use it. Share it to add people.";
	return detail.access === "edit" ? "You can ask in it and edit it." : "You can ask in it.";
});

const members = computed<Member[]>(() => props.detail?.members ?? []);
const ACCESS_LABELS = { ask: "Can ask", edit: "Can edit" } as const;
</script>

<template>
	<aside class="min-w-0 space-y-8 border-t border-outline-gray-1 pt-6 lg:border-t-0 lg:pt-0" aria-label="About this workspace" data-slot="workspace-aside">
		<section class="space-y-3" aria-labelledby="workspace-instructions-heading">
			<div class="flex h-7 items-center justify-between">
				<h2 id="workspace-instructions-heading" class="text-base-semibold text-ink-gray-9">Instructions</h2>
				<Button v-if="workspace && canEdit(workspace)" variant="ghost" label="Edit" class="-mr-2" :disabled="!detail" @click="emit('edit')" />
			</div>
			<div v-if="!detail" class="space-y-1.5" aria-busy="true">
				<div v-for="width in ['w-full', 'w-11/12', 'w-2/3']" :key="width" class="flex h-[1lh] items-center text-p-sm"><Skeleton :class="['h-3 rounded-4', width]" /></div>
			</div>
			<template v-else-if="instructions">
				<p data-slot="workspace-instructions" class="whitespace-pre-wrap break-words text-p-sm text-ink-gray-8" :class="{ 'line-clamp-[12]': !expanded && instructions.length > LONG }">{{ instructions }}</p>
				<Button v-if="instructions.length > LONG" variant="ghost" size="sm" class="-ml-2" :label="expanded ? 'Show less' : 'Show all'" @click="expanded = !expanded" />
			</template>
			<p v-else class="text-p-sm text-ink-gray-6">No instructions yet. Chats here answer as other chats do.</p>
		</section>

		<WorkspaceDocuments
			:workspace-id="detail?.id ?? workspace?.id ?? ''"
			:documents="detail?.documents"
			:editable="Boolean(workspace && canEdit(workspace))"
			@changed="emit('documents', $event)"
		/>

		<section class="space-y-3" aria-labelledby="workspace-shared-heading" data-slot="workspace-sharing">
			<div class="flex h-7 items-center justify-between">
				<h2 id="workspace-shared-heading" class="text-base-semibold text-ink-gray-9">Shared with</h2>
				<Button v-if="workspace && canShare(workspace)" variant="ghost" label="Change" class="-mr-2" :disabled="!detail" @click="emit('share')" />
			</div>
			<div v-if="!detail" class="flex h-9 items-center gap-2.5 text-sm" aria-busy="true">
				<Skeleton class="size-4 rounded-4" />
				<span class="flex h-[1lh] items-center"><Skeleton class="h-3 w-40 rounded-4" /></span>
			</div>
			<template v-else>
				<ul class="space-y-0.5">
					<li v-if="detail.kind === 'org'" class="flex h-9 items-center gap-2.5">
						<span :class="[kindIcon(detail), 'size-4 shrink-0 text-ink-gray-5']" aria-hidden="true" />
						<span class="min-w-0 flex-1 truncate text-sm text-ink-gray-8">Everyone in the organisation</span>
					</li>
					<template v-else-if="detail.members">
						<li class="flex h-9 items-center gap-2.5">
							<span class="lucide-user size-4 shrink-0 text-ink-gray-5" aria-hidden="true" />
							<span class="min-w-0 flex-1 truncate text-sm text-ink-gray-8">You</span>
							<span class="shrink-0 text-sm text-ink-gray-6">Owner</span>
						</li>
						<li v-for="member in members" :key="member.id" class="flex h-9 items-center gap-2.5" data-slot="workspace-member">
							<span class="lucide-user size-4 shrink-0 text-ink-gray-5" aria-hidden="true" />
							<span class="min-w-0 flex-1 truncate text-sm text-ink-gray-8" :title="member.email">{{ member.name || member.email }}</span>
							<span class="shrink-0 text-sm text-ink-gray-6">{{ ACCESS_LABELS[member.access] }}</span>
						</li>
					</template>
					<li v-else class="flex h-9 items-center gap-2.5">
						<span :class="[kindIcon(detail), 'size-4 shrink-0 text-ink-gray-5']" aria-hidden="true" />
						<span class="min-w-0 flex-1 truncate text-sm text-ink-gray-8">Shared by {{ detail.owner.name || detail.owner.email }}</span>
						<span class="shrink-0 text-sm tabular-nums text-ink-gray-6">{{ people(detail.memberCount + 1) }}</span>
					</li>
				</ul>
				<p class="text-p-sm text-ink-gray-6">{{ accessNote }}</p>
			</template>
		</section>
	</aside>
</template>
