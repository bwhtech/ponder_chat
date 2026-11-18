<script setup lang="ts">
import { Button, Dropdown } from "frappe-ui";
import { computed, onBeforeUnmount, ref } from "vue";
import { accessIcon, canDelete, canEdit, canShare, type WorkspaceSummary } from "./store";
import type { TitleHandle } from "./handles";
import WorkspaceTitle from "./WorkspaceTitle.vue";

/**
 * The workspace page's title row: who can use it (its icon) and its name, and what the person
 * may change. People who can edit rename it by its name, or with Rename in the ⋯ menu, and
 * share it with Share; on a phone Share moves into the menu. Whoever can delete it (its owner;
 * admins while it is open to everyone) gets Delete. Everything here comes from the sidebar's
 * row, so it draws at once; the actions wait (`ready`) for the workspace itself.
 */
const props = defineProps<{ workspace: Omit<WorkspaceSummary, "pinned">; ready: boolean }>();
const emit = defineEmits<{ rename: [name: string]; share: []; delete: [] }>();

// Tailwind's sm: the Share button shows from here.
const wideScreen = matchMedia("(min-width: 640px)");
const wide = ref(wideScreen.matches);
const onWidth = () => (wide.value = wideScreen.matches);
wideScreen.addEventListener("change", onWidth);
onBeforeUnmount(() => wideScreen.removeEventListener("change", onWidth));

const title = ref<TitleHandle>();
const shares = computed(() => canShare(props.workspace));
const edits = computed(() => canEdit(props.workspace));
const deletes = computed(() => canDelete(props.workspace));
const menu = computed(() => [
	...(shares.value && !wide.value ? [{ label: "Share", icon: "lucide-share-2", onClick: () => emit("share") }] : []),
	...(edits.value ? [{ label: "Rename", icon: "lucide-pencil", onClick: renameAfterMenu }] : []),
	...(deletes.value ? [{ label: "Delete", icon: "lucide-trash-2", theme: "red" as const, onClick: () => emit("delete") }] : []),
]);

/**
 * The menu gives focus back to ⋯ once it has closed (in a timeout). The field opens after
 * that, or it would lose focus at once and end the rename.
 */
let renameOnFocus = false;
function renameAfterMenu() {
	renameOnFocus = true;
	setTimeout(() => (renameOnFocus = false), 1000);
}

function onMenuFocus() {
	if (!renameOnFocus) return;
	renameOnFocus = false;
	void title.value?.start();
}
</script>

<template>
	<span class="flex size-6 shrink-0 items-center justify-center rounded-4 bg-surface-gray-2 text-ink-gray-7" aria-hidden="true">
		<span :class="[accessIcon(workspace), 'size-3.5']" />
	</span>
	<WorkspaceTitle ref="title" :name="workspace.name" :editable="ready && edits" @rename="emit('rename', $event)" />
	<div v-if="shares || edits || deletes" class="flex shrink-0 items-center gap-1">
		<Button v-if="shares && wide" icon-left="lucide-share-2" label="Share" :disabled="!ready" @click="emit('share')" />
		<Dropdown :options="menu" align="end">
			<Button variant="ghost" icon="lucide-ellipsis" aria-label="Workspace actions" class="touch-target" :disabled="!ready" @focus="onMenuFocus" />
		</Dropdown>
	</div>
</template>
