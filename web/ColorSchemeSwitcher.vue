<script setup lang="ts">
import { TabButtons, useColorScheme, type ColorScheme } from "frappe-ui";
import { computed } from "vue";

/** Light, dark, or the device's setting. frappe-ui keeps the choice in localStorage. */
const { colorScheme, setColorScheme } = useColorScheme();
const scheme = computed({
	get: () => colorScheme.value,
	set: (value) => setColorScheme(value as ColorScheme),
});
</script>

<template>
	<TabButtons
		v-model="scheme"
		:options="[
			{ label: 'Light', value: 'light', icon: 'lucide-sun' },
			{ label: 'Dark', value: 'dark', icon: 'lucide-moon' },
			{ label: 'Same as device', value: 'system', icon: 'lucide-monitor' },
		]"
	/>
</template>
