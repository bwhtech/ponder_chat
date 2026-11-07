<script setup lang="ts">
import { Button, FrappeUIProvider } from "frappe-ui";
import { onBeforeUnmount, watch } from "vue";
import { loadMe, me, meError } from "./account";
import { loadModels } from "./models";
import SignIn from "./SignIn.vue";
import { useThreads } from "./threads";
import Workspace from "./Workspace.vue";

/** Sign-in first, then the workspace. */
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
);
</script>

<template>
	<FrappeUIProvider>
		<main
			v-if="me === undefined && meError"
			class="flex h-dvh flex-col items-center justify-center gap-3 bg-surface-base px-4 text-center"
			role="alert"
		>
			<span class="lucide-wifi-off size-6 text-ink-gray-5" aria-hidden="true" />
			<p class="max-w-sm text-p-base text-ink-gray-7">{{ meError }}</p>
			<Button label="Retry" @click="retry" />
		</main>
		<div v-else-if="me === undefined" class="h-dvh bg-surface-base" aria-busy="true" />
		<SignIn v-else-if="me === null" />
		<Workspace v-else />
	</FrappeUIProvider>
</template>
