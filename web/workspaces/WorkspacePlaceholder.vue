<script setup lang="ts">
import { Skeleton } from "frappe-ui";
import { computed } from "vue";
import { kindIcon, workspaceByKey } from "./store";

/**
 * The workspace page (WorkspacePage.vue) while its code arrives: its header with the name
 * from the sidebar's row, and bars where its parts go. Vue gives it the page's props and
 * slots (Shell.vue), so the phone's buttons are already in the header.
 */
defineOptions({ inheritAttrs: false });
const props = defineProps<{ slugOrId: string }>();
const workspace = computed(() => workspaceByKey(props.slugOrId));
</script>

<template>
	<header data-slot="chat-header" class="flex min-h-12 shrink-0 border-b border-outline-gray-1">
		<div class="workspace-gutter-match flex min-w-0 items-center gap-2">
			<slot name="start" />
			<template v-if="workspace">
				<span class="flex size-6 shrink-0 items-center justify-center rounded-4 bg-surface-gray-2 text-ink-gray-7" aria-hidden="true">
					<span :class="[kindIcon(workspace), 'size-3.5']" />
				</span>
				<h1 class="min-w-0 flex-1 truncate text-lg-semibold text-ink-gray-9">{{ workspace.name }}</h1>
			</template>
			<div v-else class="flex h-[1lh] min-w-0 flex-1 items-center text-lg-semibold"><Skeleton class="h-4 w-48 max-w-full rounded-4" /></div>
			<slot name="end" />
		</div>
	</header>
	<div class="min-h-0 flex-1 overflow-hidden sm:[scrollbar-gutter:stable_both-edges]" aria-busy="true">
		<div class="mx-auto grid w-full max-w-[1120px] gap-8 px-4 pb-10 pt-6 sm:px-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-12">
			<div class="min-w-0 space-y-8">
				<p v-if="workspace?.description" class="text-p-base text-ink-gray-6">{{ workspace.description }}</p>
				<Skeleton class="h-[7.5rem] w-full rounded-[1.25rem]" />
			</div>
		</div>
	</div>
</template>
