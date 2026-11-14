<script setup lang="ts">
import { ToastProvider } from "frappe-ui";
import { onMounted } from "vue";
import { toastsListen } from "./toasts";

/** frappe-ui's toast host. It listens once mounted, after its child vue-sonner, and the waiting toasts go out (toasts.ts). */
onMounted(toastsListen);
</script>

<template>
	<ToastProvider />
</template>
