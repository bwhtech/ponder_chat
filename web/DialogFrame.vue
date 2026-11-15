<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/**
 * frappe-ui Dialog's frame (the dimmed page and the box in its centre), for a dialog whose code
 * is still on its way: Settings (settings/SettingsPlaceholder.vue) and the confirm dialogs
 * (DialogPlaceholder.vue). It has no reka-ui code, so it costs the first page almost nothing.
 * Escape, or a tap beside the box, closes it. When the real dialog takes its place, that dialog
 * skips its opening animation, so the box does not open twice.
 */
defineProps<{ label: string; size: string }>();
const emit = defineEmits<{ close: [] }>();
const box = ref<HTMLElement>();
const before = document.activeElement as HTMLElement | null;
let closing = false;

function close() {
	closing = true;
	emit("close");
}

// On the window, in the capture phase: before reka-ui's dialogs under it (Settings, the phone's
// bottom sheet), which listen on the document. Escape closes this one only, as the top dialog.
function onKeydown(event: KeyboardEvent) {
	if (event.key !== "Escape" || event.defaultPrevented) return;
	event.stopImmediatePropagation();
	close();
}

onMounted(() => {
	addEventListener("keydown", onKeydown, { capture: true });
	box.value?.focus({ preventScroll: true });
});
onBeforeUnmount(() => {
	removeEventListener("keydown", onKeydown, { capture: true });
	if (closing) return before?.focus({ preventScroll: true });
	// The real dialog mounts in this same update.
	const root = document.documentElement;
	root.dataset.dialogHandoff = "";
	setTimeout(() => delete root.dataset.dialogHandoff, 300);
});
</script>

<template>
	<!-- In <body>, as frappe-ui's dialogs are, so it covers the phone's bottom sheet too. That sheet, a
	     reka-ui dialog, turns off taps on the rest of the page and closes on a tap outside it: this
	     frame takes its own taps, and they stay here. -->
	<Teleport to="body">
		<div class="dialog-frame-overlay fixed inset-0 z-50 bg-black-overlay-200 dark:bg-black-overlay-700" aria-hidden="true" />
		<div class="dialog-scroll-container pointer-events-auto fixed inset-0 z-50 overflow-y-auto" @click.self="close" @pointerdown.stop>
			<div class="flex min-h-screen flex-col items-center justify-center px-4 py-4 text-center" @click.self="close">
				<div
					ref="box"
					data-slot="content"
					role="dialog"
					aria-modal="true"
					aria-busy="true"
					:aria-label="label"
					tabindex="-1"
					:class="['dialog-frame-content my-8 inline-block w-full overflow-hidden rounded-7 bg-surface-elevation-1 text-start align-middle shadow-xl focus-visible:outline-none', size]"
				>
					<slot />
				</div>
			</div>
		</div>
	</Teleport>
</template>

<style>
/* frappe-ui's dialog opening, which lives in the dialog's own code. */
@keyframes dialog-frame-fade {
	from {
		opacity: 0;
	}
}
@keyframes dialog-frame-in {
	from {
		opacity: 0.5;
		transform: scale(0.98);
	}
}
.dialog-frame-overlay {
	animation: dialog-frame-fade 100ms var(--ease-out-strong);
}
.dialog-frame-content {
	animation: dialog-frame-in 100ms var(--ease-out-strong);
}
@media (prefers-reduced-motion: reduce) {
	.dialog-frame-overlay,
	.dialog-frame-content {
		animation: none;
	}
}
/* The real dialog, mounted in the frame's place, is already open: its opening ends at once. Not
   animation: none, which would start it again when this rule goes. */
:root[data-dialog-handoff] :is(.dialog-overlay, .dialog-content)[data-state="open"] {
	animation-duration: 0s !important;
}
</style>
