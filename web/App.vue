<script setup lang="ts">
import { FrappeUIProvider } from "frappe-ui";
import { watch } from "vue";
import { loadMe, me } from "./account";
import { loadModels } from "./models";
import SignIn from "./SignIn.vue";
import { useThreads } from "./threads";
import Workspace from "./Workspace.vue";

/** Sign-in first, then the workspace. */
const { init } = useThreads();
let started = false;

void loadMe();
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
		<div v-if="me === undefined" class="h-dvh bg-surface-base" aria-busy="true" />
		<SignIn v-else-if="me === null" />
		<Workspace v-else />
	</FrappeUIProvider>
</template>
