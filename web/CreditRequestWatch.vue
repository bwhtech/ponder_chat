<script setup lang="ts">
import { useCreditRequestWatch } from "./credit-request";

/** Follows a request for more credits until it is answered (credit-request.ts). Mounted once one waits (Shell.vue). */
useCreditRequestWatch();
</script>

<template>
	<template v-if="false" />
</template>
