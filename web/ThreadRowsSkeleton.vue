<script setup lang="ts">
import { Skeleton } from "frappe-ui";
</script>

<template>
	<!-- The chats while they load: a group label and five rows, shaped like the list's (ThreadList.vue, SidebarPlaceholder.vue). -->
	<div class="space-y-0.5" aria-busy="true" aria-label="Loading threads">
		<Skeleton class="mx-2 mb-2 mt-1.5 h-3 w-14 rounded-4" />
		<div v-for="width in ['w-40', 'w-32', 'w-44', 'w-28', 'w-36']" :key="width" class="flex h-7 items-center px-2">
			<Skeleton :class="['h-3.5 rounded-4', width]" />
		</div>
	</div>
</template>
