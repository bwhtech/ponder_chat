<script setup lang="ts">
import { Avatar } from "frappe-ui";

/**
 * One person in Share (ShareDialog.vue, and its stand-in in WorkspaceDialogPlaceholder.vue),
 * drawn as the page's People: one line on a wider screen, the email after the name. On a phone
 * the email goes under the name, cut short (the full address is its title), and the role goes
 * on a line of its own under the name, its text under the name's. The role column is 7rem:
 * "Owner" as text, or a member's role menu (the slot), whose label starts where "Owner" does.
 */
defineProps<{ avatar: string; name: string; email?: string; owner?: boolean }>();
</script>

<template>
	<li class="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1.5 sm:h-8 sm:flex-nowrap sm:py-0">
		<Avatar :label="avatar" size="sm" class="shrink-0" />
		<div class="min-w-0 flex-1 text-sm sm:flex sm:items-baseline sm:gap-1.5">
			<p class="truncate text-ink-gray-8 sm:max-w-[60%] sm:shrink-0">{{ name }}</p>
			<p v-if="email" class="truncate text-ink-gray-6" :title="email">{{ email }}</p>
		</div>
		<div class="flex shrink-0 basis-full items-center pl-[1.375rem] sm:basis-auto sm:pl-0">
			<span v-if="owner" class="flex h-7 items-center px-2 text-base text-ink-gray-6 sm:w-28">Owner</span>
			<slot v-else />
		</div>
	</li>
</template>
