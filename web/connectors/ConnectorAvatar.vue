<script setup lang="ts">
import { Avatar } from "frappe-ui";
import { computed } from "vue";

/** A connector's first letter on a colour picked from its name, so each keeps its colour. */
const props = withDefaults(defineProps<{ name: string; size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" }>(), { size: "lg" });
const THEMES = ["blue", "green", "amber", "violet", "red", "gray"] as const;
const theme = computed(() => THEMES[[...props.name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % THEMES.length]);
</script>

<template>
	<Avatar :label="name" :theme="theme" :size="size" shape="square" />
</template>
