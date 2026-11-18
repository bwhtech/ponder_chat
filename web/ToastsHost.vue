<script setup lang="ts">
import { ToastProvider } from "frappe-ui";
import { onMounted } from "vue";
import { toastsListen } from "./toasts";

/**
 * frappe-ui's toast host. It listens once mounted, after its child vue-sonner, and the waiting
 * toasts go out (toasts.ts). Toasts show at the top, in the middle: at frappe-ui's bottom right
 * they would cover the message box and its send button, which sit at the bottom of a chat and of
 * a workspace page. `position` passes through ToastProvider to vue-sonner's Toaster.
 */
onMounted(toastsListen);
</script>

<template>
	<ToastProvider position="top-center" />
</template>
