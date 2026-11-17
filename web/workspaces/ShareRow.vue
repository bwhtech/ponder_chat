<script setup lang="ts">
import { Avatar } from "frappe-ui";

/**
 * One person in Share (PeoplePicker.vue, and its stand-in in WorkspaceDialogPlaceholder.vue),
 * drawn as the side panel's People: one line on a wider screen, the email after the name. On a
 * phone the email goes under the name, cut short (the full address is its title), and the
 * access goes on a line of its own under the name: "Owner", or a member's access and × (the
 * slot). "Owner" is drawn as the select's text is, so the access column has one left edge.
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
		<div v-if="owner" class="flex shrink-0 basis-full items-center gap-2.5 pl-[1.875rem] sm:basis-auto sm:pl-0 [@media(pointer:coarse)]:gap-x-4">
			<span class="flex h-7 items-center border border-transparent px-2 text-sm text-ink-gray-6 sm:w-28">Owner</span>
			<span class="hidden size-7 shrink-0 sm:block" aria-hidden="true" />
		</div>
		<div v-else class="flex basis-full items-center gap-2.5 pl-[1.875rem] sm:basis-auto sm:pl-0 [@media(pointer:coarse)]:gap-x-4">
			<slot />
		</div>
	</li>
</template>
