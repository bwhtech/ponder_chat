import { createAuthClient } from "better-auth/vue";
import { adminClient, emailOTPClient, magicLinkClient } from "better-auth/client/plugins";
import { ref } from "vue";

/**
 * Who is signed in, and their credits for today. Sign-in is by email (server/auth.ts):
 * the person types their email, then types the code from the email, or opens its link
 * and lands back here. Either way they get a session cookie.
 */
export type CreditRequest = { status: "pending" | "approved" | "declined"; createdAt: string; credits: number | null };
/** `limit` includes `extra`, the credits admins gave for today. `request` is the one waiting, or answered today. */
export type Credits = { limit: number; used: number; remaining: number; resetsAt: string; extra: number; request: CreditRequest | null };
export type Me = { user: { id: string; email: string; name: string; role: "admin" | "user" }; credits: Credits };

export const authClient = createAuthClient({ plugins: [magicLinkClient(), emailOTPClient(), adminClient()] });

/** Undefined while loading, null when signed out. */
export const me = ref<Me | null | undefined>(undefined);

export async function loadMe() {
	const response = await fetch("/api/me");
	me.value = response.ok ? await response.json() : null;
	if (me.value) keepCachesFor(me.value.user.id);
}

/** Asks again how many credits are left: after each reply, and when a reply is refused. */
export async function refreshCredits() {
	const response = await fetch("/api/credits");
	if (response.ok && me.value) me.value = { ...me.value, credits: await response.json() };
}

/** Sends the email with the link and the code. The page then waits for the code, or for the link to be opened. */
export async function sendSignInLink(email: string) {
	const { error } = await authClient.signIn.magicLink({ email, callbackURL: "/", errorCallbackURL: "/?sign-in=failed" });
	if (error) throw new Error(error.message ?? "The email could not be sent.");
}

/** Signs in with the code from the email, then loads who is signed in. */
export async function signInWithCode(email: string, code: string) {
	const { error } = await authClient.signIn.emailOtp({ email, otp: code });
	if (error) throw new Error(codeErrors[error.code ?? ""] ?? (error.status === 429 ? TOO_FAST : (error.message ?? "Could not sign in.")));
	await loadMe();
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

function clearCaches() {
	localStorage.removeItem("ponder-chat:threads");
	localStorage.removeItem(CACHE_OWNER);
	indexedDB?.deleteDatabase("ponder-chat");
}
