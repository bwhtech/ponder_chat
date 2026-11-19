<script setup lang="ts">
import BrandLogo from "./BrandLogo.vue";
import { Alert, Button, FormControl } from "frappe-ui";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { sendSignInLink, signInWithCode, signInWithMicrosoft } from "./account";
import { loadSignInProviders, signInWith } from "./sign-in-providers";

/**
 * Sign-in by email: no passwords. A new email signs up. The email holds a 6-digit code
 * and a link; the person types the code here or opens the link.
 *
 * When an admin set it up, people can also sign in with their Microsoft work account
 * (server/auth/microsoft.ts): the button sends them to Microsoft, and they come back signed in.
 */
void loadSignInProviders();

// Fixed text for the codes we know, so a crafted URL cannot put its own words on the page.
const linkErrors: Record<string, string> = {
	BANNED_USER: "This account is blocked. Ask the person who invited you.",
	NOT_INVITED: "This email is not invited to Ponder Chat.",
	// Sign-in with Microsoft (server/auth/microsoft.ts, Auth.ts, and Better Auth's own codes).
	WRONG_TENANT: "That Microsoft account is not of this organisation. Sign in with your work account.",
	EMAIL_DOMAIN_NOT_ALLOWED: "That Microsoft account's email is not of this organisation. Sign in with your work account.",
	LINKED_TO_ANOTHER_ACCOUNT: "Your Ponder Chat account is linked to another Microsoft account. Ask an admin for help.",
	account_not_linked: "Sign in by email once. After that, you can sign in with Microsoft.",
	email_not_found: "That Microsoft account has no email address. Sign in by email.",
	access_denied: "The Microsoft sign-in was cancelled.",
};
const LINK_FAILED = "That link has expired or was already used. Ask for a new one.";
const MICROSOFT_FAILED = "The Microsoft sign-in did not finish. Try again, or sign in by email.";

const email = ref("");
const sending = ref(false);
const sentTo = ref("");
/** On the way to Microsoft: the button stays busy until the browser leaves the page. */
const leaving = ref(false);
const error = ref(linkError());
// Shown once: a reload or a shared link should not say it again.
if (error.value) forgetLinkError();

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
	return linkErrors[params.get("error") ?? ""] ?? (params.get("with") === "microsoft" ? MICROSOFT_FAILED : LINK_FAILED);
}

function forgetLinkError() {
	const url = new URL(location.href);
	for (const name of ["sign-in", "with", "error", "error_description"]) url.searchParams.delete(name);
	history.replaceState(history.state, "", url);
}

// Back from Microsoft with the browser's Back button: the page comes out of its cache as it was left, with the button still busy.
const backFromCache = (event: PageTransitionEvent) => event.persisted && (leaving.value = false);
addEventListener("pageshow", backFromCache);
onBeforeUnmount(() => removeEventListener("pageshow", backFromCache));

async function withMicrosoft() {
	if (leaving.value) return;
	leaving.value = true;
	error.value = "";
	try {
		await signInWithMicrosoft();
	} catch (cause) {
		leaving.value = false;
		error.value = cause instanceof Error ? cause.message : String(cause);
	}
}

async function send() {
	if (sending.value) return;
	if (!email.value.trim()) {
		error.value = "Enter your email address.";
		return;
	}
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

// Each code check takes a number; "Use another email" moves it on, so a check still on its way is ignored.
let attempt = 0;

async function checkCode() {
	if (code.value.length !== 6 || checking.value) return;
	const mine = ++attempt;
	checking.value = true;
	try {
		await signInWithCode(sentTo.value, code.value, () => mine === attempt);
	} catch (cause) {
		if (mine === attempt) codeError.value = cause instanceof Error ? cause.message : String(cause);
	} finally {
		if (mine === attempt) checking.value = false;
	}
}

function useAnotherEmail() {
	attempt++;
	checking.value = false;
	codeError.value = "";
	sentTo.value = "";
}
</script>

<template>
	<!-- One centred column: the heading says what each field is for, so the fields carry no labels above them
	     that would start a second, left edge under a centred heading. -->
	<main class="flex min-h-dvh items-center justify-center bg-surface-base px-4 text-ink-gray-8" data-slot="sign-in">
		<div class="flex w-full max-w-sm flex-col gap-8">
			<div class="flex flex-col items-center gap-3 text-center">
				<BrandLogo class="mb-1 size-11" />
				<h1 class="text-4xl-semibold text-ink-gray-9">Sign in to Ponder Chat</h1>
				<p v-if="signInWith.microsoft" class="text-p-base text-ink-gray-6">Use your Microsoft work account, or get a code and a link by email.</p>
				<p v-else class="text-p-base text-ink-gray-6">We'll email you a code and a link. No password needed.</p>
			</div>

			<div v-if="sentTo" class="flex flex-col gap-3 rounded-7 border border-outline-gray-2 p-4 text-center">
				<span class="lucide-mail-check mx-auto size-6 text-ink-gray-6" aria-hidden="true" />
				<p class="text-p-base text-ink-gray-8">
					Check your email. We sent a code to <span class="font-medium text-ink-gray-9">{{ sentTo }}</span>.
				</p>
				<form class="flex flex-col gap-3" @submit.prevent="checkCode">
					<FormControl
						ref="codeField"
						v-model="code"
						aria-label="Code"
						size="md"
						placeholder="123456"
						inputmode="numeric"
						autocomplete="one-time-code"
						:error="codeError || undefined"
						class="[&_input]:text-center [&_input]:tabular-nums [&_input]:tracking-[0.3em] [@media(pointer:coarse)]:[&_input]:h-11"
						required
					/>
					<Button type="submit" variant="solid" size="md" class="[@media(pointer:coarse)]:h-11" :loading="checking" :disabled="code.length !== 6">Sign in</Button>
				</form>
				<p class="text-p-sm text-ink-gray-5">Or open the link in the email. The code and the link expire in 15 minutes.</p>
				<Button variant="ghost" class="mx-auto" @click="useAnotherEmail">Use another email</Button>
			</div>

			<div v-else class="flex flex-col gap-4">
				<template v-if="signInWith.microsoft">
					<Button variant="outline" size="md" class="[@media(pointer:coarse)]:h-11" :loading="leaving" data-slot="sign-in-microsoft" @click="withMicrosoft">
						<template #prefix>
							<!-- Microsoft's mark: four squares, in its own colours. -->
							<svg class="size-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
								<rect width="7.5" height="7.5" fill="#f25022" />
								<rect x="8.5" width="7.5" height="7.5" fill="#7fba00" />
								<rect y="8.5" width="7.5" height="7.5" fill="#00a4ef" />
								<rect x="8.5" y="8.5" width="7.5" height="7.5" fill="#ffb900" />
							</svg>
						</template>
						Sign in with Microsoft
					</Button>
					<div class="flex items-center gap-3 text-p-sm text-ink-gray-6">
						<span class="h-px flex-1 bg-outline-gray-2" aria-hidden="true" />
						or
						<span class="h-px flex-1 bg-outline-gray-2" aria-hidden="true" />
					</div>
				</template>
				<form class="flex flex-col gap-3" @submit.prevent="send">
					<FormControl v-model="email" type="email" aria-label="Email" size="md" class="[@media(pointer:coarse)]:[&_input]:h-11" placeholder="Email address" autocomplete="email" :autofocus="!signInWith.microsoft" />
					<Button type="submit" :variant="signInWith.microsoft ? 'subtle' : 'solid'" size="md" class="[@media(pointer:coarse)]:h-11" :loading="sending">Email me a link</Button>
				</form>
			</div>

			<Alert v-if="error" theme="red" title="Could not sign you in" :description="error" />
		</div>
	</main>
</template>
