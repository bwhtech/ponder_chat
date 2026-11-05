<script setup lang="ts">
import { Alert, Button, FormControl } from "frappe-ui";
import { ref } from "vue";
import { sendSignInLink } from "./account";

/** Sign-in by email link: no passwords. A new email signs up. */
const email = ref("");
const sending = ref(false);
const sentTo = ref("");
const error = ref(failedLink() ? "That link has expired or was already used. Ask for a new one." : "");

function failedLink() {
	const params = new URL(location.href).searchParams;
	return params.has("sign-in") || params.has("error");
}

async function send() {
	if (!email.value.trim() || sending.value) return;
	sending.value = true;
	error.value = "";
	try {
		await sendSignInLink(email.value.trim());
		sentTo.value = email.value.trim();
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : String(cause);
	} finally {
		sending.value = false;
	}
}
</script>

<template>
	<main class="flex min-h-dvh items-center justify-center bg-surface-base px-4 text-ink-gray-8" data-slot="sign-in">
		<div class="flex w-full max-w-sm flex-col gap-6">
			<div class="flex flex-col items-center gap-3 text-center">
				<span class="flex size-10 items-center justify-center rounded-full bg-surface-green-2">
					<span class="lucide-sprout size-5 text-ink-green-6" aria-hidden="true" />
				</span>
				<h1 class="text-2xl-semibold text-ink-gray-9">Sign in to Seva Chat</h1>
				<p class="text-p-base text-ink-gray-6">We'll email you a link. No password needed.</p>
			</div>

			<div v-if="sentTo" class="flex flex-col gap-3 rounded-7 border border-outline-gray-2 p-4 text-center">
				<span class="lucide-mail-check mx-auto size-6 text-ink-gray-6" aria-hidden="true" />
				<p class="text-p-base text-ink-gray-8">
					Check your email. We sent a sign-in link to <span class="font-medium text-ink-gray-9">{{ sentTo }}</span>.
				</p>
				<p class="text-p-sm text-ink-gray-5">It works once and expires in 15 minutes.</p>
				<Button variant="ghost" class="mx-auto" @click="sentTo = ''">Use another email</Button>
			</div>

			<form v-else class="flex flex-col gap-3" @submit.prevent="send">
				<FormControl v-model="email" type="email" label="Email" placeholder="you@example.org" autocomplete="email" autofocus required />
				<Button type="submit" variant="solid" size="md" :loading="sending" :disabled="!email.trim()">Email me a link</Button>
			</form>

			<Alert v-if="error" theme="red" title="Could not sign you in" :description="error" />
		</div>
	</main>
</template>
