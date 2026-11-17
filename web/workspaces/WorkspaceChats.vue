<script setup lang="ts">
import { Skeleton } from "frappe-ui";
import { computed } from "vue";
import { when } from "../dates";
import { useThreads } from "../threads";

/**
 * "Your chats": the person's own chats in this workspace, newest first. A chat stays its
 * writer's own, also in a shared workspace, so nobody else's chats are listed.
 */
const props = defineProps<{ workspaceId: string }>();
const emit = defineEmits<{ open: [id: string] }>();

const { threads, listLoaded, prefetch } = useThreads();
const chats = computed(() => threads.value.filter((thread) => thread.workspaceId === props.workspaceId));
</script>

<template>
	<section class="space-y-3" aria-labelledby="workspace-chats-heading" data-slot="workspace-chats">
		<div class="flex h-7 items-center justify-between gap-3">
			<h2 id="workspace-chats-heading" class="text-base-semibold text-ink-gray-9">Your chats</h2>
			<p class="flex items-center gap-1.5 text-sm text-ink-gray-6" data-slot="workspace-chats-private">
				<span class="lucide-lock size-3.5 shrink-0" aria-hidden="true" />
				Chats are never shared
			</p>
		</div>
		<ul v-if="!listLoaded || !workspaceId" class="space-y-0.5" aria-busy="true" aria-label="Loading chats">
			<li v-for="width in ['w-56', 'w-40', 'w-48']" :key="width" class="flex h-10 items-center justify-between gap-3 text-base">
				<span class="flex h-[1lh] items-center"><Skeleton :class="['h-4 rounded-4', width]" /></span>
				<span class="flex h-[1lh] items-center text-sm"><Skeleton class="h-3 w-16 rounded-4" /></span>
			</li>
		</ul>
		<ul v-else-if="chats.length" class="-mx-2 space-y-0.5">
			<li v-for="chat in chats" :key="chat.id">
				<button
					type="button"
					class="flex h-10 w-full items-center gap-3 rounded-4 px-2 text-left transition-colors duration-150 ease-out-strong hover:bg-surface-gray-2 active:bg-surface-gray-3 motion-reduce:transition-none [@media(pointer:coarse)]:h-11"
					@click="emit('open', chat.id)"
					@pointerenter="prefetch(chat.id)"
					@focus="prefetch(chat.id)"
				>
					<span class="min-w-0 flex-1 truncate text-base text-ink-gray-8">{{ chat.title }}</span>
					<span class="shrink-0 text-sm tabular-nums text-ink-gray-6">{{ when(chat.updatedAt) }}</span>
				</button>
			</li>
		</ul>
		<p v-else class="text-p-sm text-ink-gray-6">No chats yet.</p>
	</section>
</template>
