<script setup lang="ts">
import { Button, ToastProvider } from "frappe-ui";
import { defineAsyncComponent, onBeforeUnmount, watch } from "vue";
import { loadMe, me, meError } from "./account";
import { dialogsWanted, loadDialogs } from "./dialogs";
import { loadModels } from "./models";
import { useThreads } from "./threads";
import Workspace from "./Workspace.vue";
import EmptyState from "./EmptyState.vue";

/** Sign-in first, then the workspace. Someone signed in never needs the sign-in page, so it loads only when shown. */
const SignIn = defineAsyncComponent(() => import("./SignIn.vue"));
// What frappe-ui's FrappeUIProvider mounts, but the dialogs' host only once a dialog opens (dialogs.ts).
const Dialogs = defineAsyncComponent(() => loadDialogs().then((module) => module.Dialogs));
const { init } = useThreads();
let started = false;

void loadMe();
// Offline at first: ask again when the connection comes back, or on Retry.
const retry = () => me.value === undefined && void loadMe();
addEventListener("online", retry);
onBeforeUnmount(() => removeEventListener("online", retry));
// The threads and the model list load once someone is signed in.
watch(
	() => Boolean(me.value),
	(ready) => {
		if (!ready || started) return;
		started = true;
		void init();
		void loadModels();
	},
	// The page may say who is signed in already (boot.ts), before this watch starts.
	{ immediate: true },
);
</script>

<template>
	<!-- Before the app, so toasts from its setup land (as in frappe-ui's FrappeUIProvider). -->
	<ToastProvider />
	<EmptyState v-if="me === undefined && meError" icon="lucide-wifi-off" title="Can't reach Ponder" :body="meError" alert class="h-dvh bg-surface-base">
		<Button label="Try again" @click="retry" />
	</EmptyState>
	<div v-else-if="me === undefined" class="h-dvh bg-surface-base" aria-busy="true" />
	<SignIn v-else-if="me === null" />
	<Workspace v-else />
	<Dialogs v-if="dialogsWanted" />
</template>
