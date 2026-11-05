<script setup lang="ts">
import { Alert, Button, FormControl } from "frappe-ui";
import { nextTick, ref, watch } from "vue";
import { sendSignInLink, signInWithCode } from "./account";

/**
 * Sign-in by email: no passwords. A new email signs up. The email holds a 6-digit code
 * and a link; the person types the code here or opens the link.
 */

// Fixed text for the codes we know, so a crafted URL cannot put its own words on the page.
const linkErrors: Record<string, string> = {
	BANNED_USER: "This account is blocked. Ask the person who invited you.",
	NOT_INVITED: "This email is not invited to Ponder Chat.",
};

const email = ref("");
const sending = ref(false);
const sentTo = ref("");
const error = ref(linkError());

const code = ref("");
const checking = ref(false);
const codeError = ref("");
const codeField = ref<{ focus: () => void } | null>(null);

// Digits only, so a pasted "123 456" still works.
watch(code, (value) => {
	code.value = value.replace(/\D/g, "").slice(0, 6);
	codeError.value = "";
});

/** Why a link from the email did not sign the person in: the server sends them back here with a code. */
function linkError() {
	const params = new URL(location.href).searchParams;
	if (!params.has("sign-in") && !params.has("error")) return "";
	return linkErrors[params.get("error") ?? ""] ?? "That link has expired or was already used. Ask for a new one.";
}

async function send() {
	if (!email.value.trim() || sending.value) return;
	sending.value = true;
	error.value = "";
	try {
		await sendSignInLink(email.value.trim());
		sentTo.value = email.value.trim();
		code.value = "";
		await nextTick();
		codeField.value?.focus();
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : String(cause);
	} finally {
		sending.value = false;
	}
}

async function checkCode() {
	if (code.value.length !== 6 || checking.value) return;
	checking.value = true;
	try {
		await signInWithCode(sentTo.value, code.value);
	} catch (cause) {
		codeError.value = cause instanceof Error ? cause.message : String(cause);
	} finally {
		checking.value = false;
	}
}
</script>

<template>
	<main class="flex min-h-dvh items-center justify-center bg-surface-base px-4 text-ink-gray-8" data-slot="sign-in">
		<div class="flex w-full max-w-sm flex-col gap-6">
			<div class="flex flex-col items-center gap-3 text-center">
				<img src="/logo.png" alt="" class="size-12" />
				<h1 class="text-2xl-semibold text-ink-gray-9">Sign in to Ponder Chat</h1>
				<p class="text-p-base text-ink-gray-6">We'll email you a code and a link. No password needed.</p>
			</div>

			<div v-if="sentTo" class="flex flex-col gap-3 rounded-7 border border-outline-gray-2 p-4 text-center">
				<span class="lucide-mail-check mx-auto size-6 text-ink-gray-6" aria-hidden="true" />
				<p class="text-p-base text-ink-gray-8">
					Check your email. We sent a code to <span class="font-medium text-ink-gray-9">{{ sentTo }}</span>.
				</p>
				<form class="flex flex-col gap-3 text-left" @submit.prevent="checkCode">
					<FormControl
						ref="codeField"
						v-model="code"
						label="Code"
						size="lg"
						placeholder="123456"
						inputmode="numeric"
						autocomplete="one-time-code"
						:error="codeError || undefined"
						class="[&_input]:text-center [&_input]:tabular-nums [&_input]:tracking-[0.3em]"
						required
					/>
					<Button type="submit" variant="solid" size="md" :loading="checking" :disabled="code.length !== 6">Sign in</Button>
				</form>
				<p class="text-p-sm text-ink-gray-5">Or open the link in the email. The code and the link expire in 15 minutes.</p>
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
