<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import { once } from "./once";
import WebToolsChip from "./WebToolsChip.vue";

/**
 * Web search and deep research in a message box (web-tools.ts): one menu, drawn as the model
 * menu is, whose button names where the answer comes from. The menu loads as its own chunk;
 * its button stands in until it is here, with the same props, so the box does not move.
 */
const loadMenu = once(() => import("./WebToolsMenu.vue").then((module) => module.default));
const WebToolsMenu = defineAsyncComponent({ loader: loadMenu, loadingComponent: WebToolsChip, delay: 0 });
defineProps<{ inWorkspace?: boolean; disabled?: boolean }>();
const web = defineModel<boolean>("web", { required: true });
const research = defineModel<boolean>("research", { required: true });
</script>

<template>
	<WebToolsMenu v-model:web="web" v-model:research="research" :in-workspace="inWorkspace" :disabled="disabled" />
</template>
