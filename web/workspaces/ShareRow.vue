<script setup lang="ts">
import { Avatar } from "frappe-ui";

/**
 * One person or team in Share (ShareDialog.vue, and its stand-in in WorkspaceDialogPlaceholder.vue),
 * drawn as the page's People: one line on a wider screen, the email after the name. On a phone
 * the email goes under the name, cut short (the full address is its title), and the role goes
 * on a line of its own under the name, its text under the name's. The role column is 7rem:
 * "Owner" as text, or a member's role menu (the slot), whose label starts where "Owner" does.
 *
 * A team has an icon in place of the avatar, and its member count in place of the email. An
 * archived team is `muted`: greyed out, as it gives no access.
 */
defineProps<{ avatar?: string; icon?: string; name: string; email?: string; owner?: boolean; muted?: boolean }>();
</script>

<template>
	<li class="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1.5 sm:h-8 sm:flex-nowrap sm:py-0">
		<span
			v-if="icon"
			class="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-gray-2"
			:class="muted ? 'text-ink-gray-4' : 'text-ink-gray-6'"
			aria-hidden="true"
		>
			<span :class="[icon, 'size-3']" />
		</span>
		<Avatar v-else :label="avatar" size="sm" class="shrink-0" />
		<div class="min-w-0 flex-1 text-sm sm:flex sm:items-baseline sm:gap-1.5">
			<p class="truncate sm:max-w-[60%] sm:shrink-0" :class="muted ? 'text-ink-gray-6' : 'text-ink-gray-8'">{{ name }}</p>
			<p v-if="email" class="truncate text-ink-gray-6" :title="email">{{ email }}</p>
		</div>
		<div class="flex shrink-0 basis-full items-center pl-[1.375rem] sm:basis-auto sm:pl-0">
			<span v-if="owner" class="flex h-7 items-center px-2 text-base text-ink-gray-6 sm:w-28">Owner</span>
			<slot v-else />
		</div>
	</li>
</template>
