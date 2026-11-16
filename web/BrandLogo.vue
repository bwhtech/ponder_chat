<script setup lang="ts">
import { logoUrl } from "./brand";

/**
 * The logo (brand.ts), for the theme the page is in. Both images are in the page and CSS shows
 * one, so a theme switch shows the other at once. A <picture> would follow the system's
 * theme, not the one picked in the app. Its size comes from the parent or a class.
 */
</script>

<template>
	<span class="block">
		<img :src="logoUrl('light')" alt="" class="size-full object-contain dark:hidden" />
		<img :src="logoUrl('dark')" alt="" class="hidden size-full object-contain dark:block" />
	</span>
</template>
