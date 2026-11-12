import { createAuthClient } from "better-auth/vue";
import { adminClient, emailOTPClient, magicLinkClient } from "better-auth/client/plugins";
import { ref } from "vue";
import { client, type Answer } from "./api";
import { model } from "./models";

/**
 * Who is signed in, and their credits for today. Sign-in is by email (server/auth.ts):
 * the person types their email, then types the code from the email, or opens its link
 * and lands back here. Either way they get a session cookie.
 */
export type Me = Answer<typeof client.api.me.$get>;
/** Today's credits (CreditStatus in server/credits.ts). */
export type Credits = Me["credits"];

export const authClient = createAuthClient({ plugins: [magicLinkClient(), emailOTPClient(), adminClient()] });

/** Undefined while loading, null when signed out. */
export const me = ref<Me | null | undefined>(undefined);
/** Why the last loadMe could not tell who is signed in (offline, or the server failed); empty when it could. */
export const meError = ref("");

/**
 * Asks who is signed in, and returns it. Only a 401 or 403 means signed out. When the server
 * cannot be reached or fails, `me` stays as it was and `meError` says why, so App.vue can offer Retry.
 */
export async function loadMe() {
	try {
		const response = await client.api.me.$get();
		// The route's type has only its 200: the 401 comes from the session check before it.
		if ([401, 403].includes(response.status)) me.value = null;
		else if (!response.ok) throw new Error(`The server answered ${response.status}.`);
		else me.value = await response.json();
		meError.value = "";
	} catch {
		meError.value = "Ponder Chat could not reach the server. Check your connection, then try again.";
	}
	if (me.value) keepCachesFor(me.value.user.id);
	return me.value;
}

/** Asks again how many credits are left: after each reply, and when a reply is refused. */
export async function refreshCredits() {
	const response = await client.api.credits.$get();
	if (response.ok && me.value) me.value = { ...me.value, credits: await response.json() };
}

/** Sends the email with the link and the code. The page then waits for the code, or for the link to be opened. */
export async function sendSignInLink(email: string) {
	const { error } = await authClient.signIn.magicLink({ email, callbackURL: "/", errorCallbackURL: "/?sign-in=failed" });
	if (error) throw new Error(error.message ?? "The email could not be sent.");
}

/**
 * Signs in with the code from the email, then loads who is signed in. `stillWanted` says
 * whether the person still waits for this code: when they chose another email meanwhile, a
 * code that worked is signed out again, and nothing is reported.
 */
export async function signInWithCode(email: string, code: string, stillWanted = () => true) {
	const { error } = await authClient.signIn.emailOtp({ email, otp: code });
	if (!stillWanted()) {
		if (!error) await authClient.signOut().catch(() => undefined);
		return;
	}
	if (error) throw new Error(codeErrors[error.code ?? ""] ?? (error.status === 429 ? TOO_FAST : (error.message ?? "Could not sign in.")));
	// The code worked, but who is signed in could not be read: say so, rather than stay on this page with no word.
	if (!(await loadMe())) throw new Error(meError.value ? `${meError.value} Then reload the page.` : "Could not sign in. Reload the page and try again.");
}

// Better Auth's codes for a code that did not work (plugins/email-otp/error-codes).
const codeErrors: Record<string, string> = {
	INVALID_OTP: "That code is not right. Check the email and try again.",
	OTP_EXPIRED: "That code has expired. Ask for a new email.",
	TOO_MANY_ATTEMPTS: "Too many wrong codes. Ask for a new email.",
};
const TOO_FAST = "Too many tries. Wait a minute, then try again.";

export async function signOut() {
	await authClient.signOut();
	clearCaches();
	location.assign("/");
}

// Threads are kept on the device (thread-cache.ts, threads.ts) for whoever is signed in.
// Another person signing in on the same browser starts with none of them.
const CACHE_OWNER = "ponder-chat:user";

function keepCachesFor(userId: string) {
	if (localStorage.getItem(CACHE_OWNER) === userId) return;
	clearCaches();
	localStorage.setItem(CACHE_OWNER, userId);
}

// The drafts (drafts.ts) and the model picked (models.ts) are the person's too.
function clearCaches() {
	localStorage.removeItem("ponder-chat:threads");
	localStorage.removeItem("ponder-chat:drafts:v1");
	localStorage.removeItem("ponder-chat:model");
	// models.ts read the last person's pick when the page loaded.
	model.value = "";
	localStorage.removeItem(CACHE_OWNER);
	indexedDB?.deleteDatabase("ponder-chat");
}
