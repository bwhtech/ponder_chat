<script setup lang="ts">
import { when } from "../dates";
import { useThreads, useWorkspaceThreads } from "../threads";

/**
 * "Your chats": the person's own chats in this workspace, newest first, once there is one.
 * A chat stays its writer's own, also in a shared workspace, so nobody else's chats are
 * listed; where other people use the workspace (`shared`), the heading says so. The list is
 * the server's for this workspace, so older chats show however many newer ones are elsewhere.
 */
const props = defineProps<{ workspaceId: string; shared: boolean }>();
const emit = defineEmits<{ open: [id: string] }>();

const { prefetch } = useThreads();
const { chats } = useWorkspaceThreads(() => props.workspaceId);
</script>

<template>
	<section v-if="chats.length" class="space-y-3" aria-labelledby="workspace-chats-heading" data-slot="workspace-chats">
		<div class="flex h-7 items-center justify-between gap-3">
			<h2 id="workspace-chats-heading" class="text-base-semibold text-ink-gray-9">Your chats</h2>
			<p v-if="shared" class="flex items-center gap-1.5 text-sm text-ink-gray-6" data-slot="workspace-chats-private">
				<span class="lucide-lock size-3.5 shrink-0" aria-hidden="true" />
				Chats are never shared
			</p>
		</div>
		<ul class="-mx-2 space-y-0.5">
			<li v-for="chat in chats" :key="chat.id">
				<button
					type="button"
					class="flex h-10 w-full items-center gap-2.5 rounded-4 px-2 text-left transition-colors duration-150 ease-out-strong hover:bg-surface-gray-2 active:bg-surface-gray-3 motion-reduce:transition-none [@media(pointer:coarse)]:h-11"
					@click="emit('open', chat.id)"
					@pointerenter="prefetch(chat.id)"
					@focus="prefetch(chat.id)"
				>
					<span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
						<span class="lucide-message-circle size-4 text-ink-gray-5" />
					</span>
					<span class="min-w-0 flex-1 truncate text-base text-ink-gray-8">{{ chat.title }}</span>
					<span class="shrink-0 text-sm tabular-nums text-ink-gray-6">{{ when(chat.updatedAt) }}</span>
				</button>
			</li>
		</ul>
	</section>
</template>
