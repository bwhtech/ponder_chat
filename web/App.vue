<script setup lang="ts">
import { Button } from "frappe-ui";
import { defineAsyncComponent, onBeforeUnmount, watch } from "vue";
import { loadMe, me, meError } from "./account";
import { dialogsWanted, loadDialogs } from "./dialogs";
import { loadToasts, toastsWanted } from "./toasts";
import { loadModels } from "./models";
import { useThreads } from "./threads";
import Shell from "./Shell.vue";
import EmptyState from "./EmptyState.vue";

/** Sign-in first, then the signed-in shell. Someone signed in never needs the sign-in page, so it loads only when shown. */
const SignIn = defineAsyncComponent(() => import("./SignIn.vue"));
// What frappe-ui's FrappeUIProvider mounts, each only once it is needed: the dialogs' host
// when a dialog opens (dialogs.ts), the toasts' host when a toast shows (toasts.ts).
const Dialogs = defineAsyncComponent(() => loadDialogs().then((module) => module.Dialogs));
const ToastsHost = defineAsyncComponent(() => loadToasts().then((module) => module.ToastsHost));
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
	<ToastsHost v-if="toastsWanted" />
	<EmptyState v-if="me === undefined && meError" icon="lucide-wifi-off" title="Can't reach Ponder" :body="meError" alert class="h-dvh bg-surface-base">
		<Button label="Try again" @click="retry" />
	</EmptyState>
	<div v-else-if="me === undefined" class="h-dvh bg-surface-base" aria-busy="true" />
	<SignIn v-else-if="me === null" />
	<Shell v-else />
	<Dialogs v-if="dialogsWanted" />
</template>
