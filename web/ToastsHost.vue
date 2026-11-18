<script setup lang="ts">
import { ToastProvider } from "frappe-ui";
import { onBeforeUnmount, onMounted } from "vue";
import { toastsListen } from "./toasts";

/**
 * frappe-ui's toast host. It listens once mounted, after its child vue-sonner, and the waiting
 * toasts go out (toasts.ts).
 *
 * Toasts show at the top, 8px under the page's header (48px, under the safe area on a phone),
 * so they cover neither the title and its buttons nor the message box at the bottom. On a wide
 * screen they are centred on the page's column, beside the sidebar, not on the window: the
 * column's middle is `--toast-centre-x` (style.css). `position` and the offsets pass through
 * ToastProvider to vue-sonner's Toaster; on a phone vue-sonner adds the safe area itself.
 */
const OFFSET = { top: "calc(env(safe-area-inset-top) + 56px)" };
const MOBILE_OFFSET = { top: "56px" };

const root = document.documentElement;
let column: HTMLElement | null = null;
const centre = () => {
	const box = column?.getBoundingClientRect();
	if (box?.width) root.style.setProperty("--toast-centre-x", `${box.left + box.width / 2}px`);
	else root.style.removeProperty("--toast-centre-x");
};
const observer = new ResizeObserver(centre);
onMounted(() => {
	toastsListen();
	column = document.querySelector<HTMLElement>('[data-slot="chat-column"]');
	if (column) observer.observe(column);
	addEventListener("resize", centre);
	centre();
});
onBeforeUnmount(() => {
	observer.disconnect();
	removeEventListener("resize", centre);
});
</script>

<template>
	<ToastProvider position="top-center" :offset="OFFSET" :mobile-offset="MOBILE_OFFSET" />
</template>
