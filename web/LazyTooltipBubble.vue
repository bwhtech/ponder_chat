<script setup lang="ts">
import { injectTooltipRootContext } from "reka-ui";
import { defineAsyncComponent, ref, watch } from "vue";

/**
 * Stands in for frappe-ui's TooltipBubble, the popup of a tooltip, in the chat's build
 * (vite.config.ts): frappe-ui's Button and Tooltip import this in its place. The real one
 * brings reka-ui's Popper, floating-ui and its dismiss layer, 40 KB of the first page for a
 * hint shown on hover. This draws nothing until its tooltip first opens (a tooltip shows its
 * bubble only while open), then loads the real one and passes everything on to it.
 */
defineOptions({ inheritAttrs: false });

const TooltipBubble = defineAsyncComponent(() => import("../node_modules/frappe-ui/src/components/Tooltip/TooltipBubble.vue"));
const root = injectTooltipRootContext();
const opened = ref(false);
watch(root.open, (open) => open && (opened.value = true), { immediate: true });
</script>

<template>
	<TooltipBubble v-if="opened" v-bind="$attrs">
		<template v-if="$slots.content" #content><slot name="content" /></template>
	</TooltipBubble>
</template>
