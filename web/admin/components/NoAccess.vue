<script setup lang="ts">
import { Button } from "frappe-ui";

/** Signed in, but without the admin role. */
defineProps<{ email: string }>();

// The chat is another page, outside this app's router.
const backToChat = () => location.assign("/");
</script>

<template>
	<main class="flex h-full items-center justify-center px-4">
		<div class="flex max-w-sm flex-col items-center gap-3 text-center">
			<div class="rounded-full bg-surface-gray-2 p-3 text-ink-gray-5">
				<span class="lucide-lock size-6" aria-hidden="true" />
			</div>
			<h1 class="text-xl-semibold text-ink-gray-9">This page is for admins</h1>
			<p class="text-p-base text-ink-gray-6">
				You're signed in as {{ email }}, which doesn't have the admin role. Ask an admin if you need access.
			</p>
			<Button variant="solid" theme="gray" icon-left="lucide-arrow-left" label="Back to chat" class="mt-2" @click="backToChat" />
		</div>
	</main>
</template>
