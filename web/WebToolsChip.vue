<script setup lang="ts">
import { Button } from "frappe-ui";
import { computed } from "vue";
import { scopeLabel } from "./web-scope";

/**
 * The button of the message box's Web menu (WebToolsMenu.vue), drawn as the model menu's
 * button is: it names where the answer comes from. Deep research, which is slow, costs more
 * and turns itself off after the next message, gets a gray fill so it is seen before sending.
 * It also stands in for the menu while the menu's code loads (WebTools.vue), with its props.
 */
defineOptions({ inheritAttrs: false });
const props = defineProps<{ web: boolean; research: boolean; inWorkspace?: boolean; disabled?: boolean }>();
defineEmits<{ "update:web": [on: boolean]; "update:research": [on: boolean] }>();
const scope = computed(() => scopeLabel(props));
</script>

<template>
	<Button
		:variant="research ? 'subtle' : 'ghost'"
		size="sm"
		:icon-left="scope.icon"
		icon-right="lucide-chevron-down"
		data-web-menu
		:data-research="research || undefined"
		:aria-label="`Answer from: ${scope.label}`"
		title="Web search and deep research"
		:disabled="disabled"
		v-bind="$attrs"
		class="touch-target relative shrink-0 transition-[background-color,color] duration-150 ease-out-strong motion-reduce:transition-none"
		:class="research ? '!text-ink-gray-8' : web ? '!text-ink-gray-7 hover:!text-ink-gray-8' : '!text-ink-gray-6 hover:!text-ink-gray-8'"
	>
		{{ scope.label }}
	</Button>
</template>
