<script setup lang="ts">
import { Button } from "frappe-ui";
import type { ModelOption } from "frappe-ui-ai-elements";
import { computed } from "vue";
import { modelMenuAsked } from "./models";

/**
 * The model menu's button (frappe-ui-ai-elements' ModelSelector) while the menu's code arrives:
 * the same button with the same name, so the message box does not move. A tap shows a spinner,
 * and the menu opens once its code is here (model-selector.ts). Vue gives it ModelSelector's props.
 */
defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{ models: ModelOption[]; modelValue?: string; label?: string }>(), { label: "Model" });
const current = computed(() => props.models.find((option) => option.id === props.modelValue));
</script>

<template>
	<Button
		variant="ghost"
		size="sm"
		:icon-right="modelMenuAsked ? 'lucide-loader-circle' : 'lucide-chevron-down'"
		:aria-label="`${label}: ${current?.name ?? 'none'}${modelMenuAsked ? ', opening' : ''}`"
		class="relative min-w-0 max-w-full !text-ink-gray-6 after:absolute after:inset-0 after:content-[''] hover:!text-ink-gray-8 [@media(pointer:coarse)]:after:-inset-y-2 [&_.lucide-loader-circle]:animate-spin [&_.lucide-loader-circle]:motion-reduce:animate-none"
		@click="modelMenuAsked = true"
	>
		{{ current?.name ?? label }}
	</Button>
</template>
