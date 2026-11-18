<script setup lang="ts">
import { Skeleton } from "frappe-ui";
</script>

<template>
	<!-- Workspaces while they load: rows shaped like the sidebar's (WorkspaceRows.vue), an icon and a name. -->
	<div class="space-y-0.5" aria-busy="true" aria-label="Loading workspaces">
		<div v-for="width in ['w-28', 'w-36']" :key="width" class="flex h-7 items-center gap-2 px-2">
			<Skeleton class="size-4 rounded-4" />
			<Skeleton :class="['h-3.5 rounded-4', width]" />
		</div>
	</div>
</template>
