<script setup lang="ts">
/**
 * "Ask your first question": a few questions to start with, where the person's chats will be
 * (WorkspaceOnboarding.vue, onboarding.ts). A click puts the question in the message box to
 * edit or send; it sends nothing. With no question to offer, one line points to the box.
 */
defineProps<{ name: string; questions: string[] }>();
const emit = defineEmits<{ pick: [question: string] }>();
</script>

<template>
	<section v-if="questions.length" class="space-y-3" aria-labelledby="workspace-starters-heading" data-slot="workspace-starters">
		<div class="flex h-7 items-center">
			<h2 id="workspace-starters-heading" class="text-base-semibold text-ink-gray-9">Ask your first question</h2>
		</div>
		<ul class="divide-y divide-outline-gray-1 overflow-hidden rounded-7 border border-outline-gray-2">
			<li v-for="question in questions" :key="question">
				<button
					type="button"
					class="flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 ease-out-strong hover:bg-surface-gray-1 active:bg-surface-gray-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-outline-gray-3 motion-reduce:transition-none"
					data-slot="workspace-starter"
					@click="emit('pick', question)"
				>
					<span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
						<span class="lucide-message-circle size-4 text-ink-gray-5" />
					</span>
					<span class="min-w-0 flex-1 truncate text-base text-ink-gray-8">{{ question }}</span>
				</button>
			</li>
		</ul>
		<p class="flex items-center gap-1.5 pt-1 text-sm text-ink-gray-6">
			Or ask your own below.
			<span class="lucide-arrow-down size-3.5 shrink-0" aria-hidden="true" />
		</p>
	</section>
	<p v-else class="flex h-7 items-center gap-1.5 text-base text-ink-gray-6" data-slot="workspace-starters">
		<span class="min-w-0 truncate">Ask a question about {{ name }} below.</span>
		<span class="lucide-arrow-down size-3.5 shrink-0" aria-hidden="true" />
	</p>
</template>
