<script setup lang="ts">
import { Button, FrappeUIProvider } from "frappe-ui";
import { onBeforeUnmount, watch } from "vue";
import { loadMe, me, meError } from "./account";
import { loadModels } from "./models";
import SignIn from "./SignIn.vue";
import { useThreads } from "./threads";
import Workspace from "./Workspace.vue";
import EmptyState from "./EmptyState.vue";

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
		<EmptyState v-if="me === undefined && meError" icon="lucide-wifi-off" title="Can't reach Ponder" :body="meError" alert class="h-dvh bg-surface-base">
			<Button label="Try again" @click="retry" />
		</EmptyState>
		<div v-else-if="me === undefined" class="h-dvh bg-surface-base" aria-busy="true" />
		<SignIn v-else-if="me === null" />
		<Workspace v-else />
	</FrappeUIProvider>
</template>
