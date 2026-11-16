<script setup lang="ts">
/**
 * Says that another page is on its way, such as /admin from the account menu: a bar that runs
 * along the top, and a note where the toasts show, in their look. On a phone on a slow network
 * that page takes seconds to start drawing, and the chat would sit still until it does.
 * Nothing here takes a tap.
 */
defineProps<{ label: string }>();
</script>

<template>
	<div class="page-opening-bar pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-[60] h-0.5 origin-left bg-surface-gray-7" aria-hidden="true" />
	<div
		role="status"
		class="page-opening-note pointer-events-none fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] flex items-center gap-2 rounded-5 bg-surface-gray-9 px-4 py-2.5 shadow-xl sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-[360px]"
	>
		<span class="lucide-loader-circle size-4 shrink-0 animate-spin text-ink-base motion-reduce:animate-none" aria-hidden="true" />
		<span class="text-p-base font-medium text-ink-base">{{ label }}</span>
	</div>
</template>

<style>
/* Quick at first, then slower and slower: it never says the page is there before it is. */
@keyframes page-opening-progress {
	from {
		transform: scaleX(0);
	}
	to {
		transform: scaleX(0.92);
	}
}
@keyframes page-opening-note-in {
	from {
		opacity: 0;
		transform: translateY(8px);
	}
}
.page-opening-bar {
	animation: page-opening-progress 8s var(--ease-out-strong) forwards;
}
.page-opening-note {
	animation: page-opening-note-in 200ms var(--ease-out-strong);
}
@media (prefers-reduced-motion: reduce) {
	.page-opening-bar {
		animation: none;
	}
	.page-opening-note {
		animation-name: fade-in;
	}
}
</style>
