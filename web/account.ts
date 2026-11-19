import { ref } from "vue";
import { client, type Answer } from "./api";
import { fromBoot } from "./boot";
import { once } from "./once";

/**
 * Who is signed in, and their credits for today. Sign-in is by email (server/auth/Auth.ts):
 * the person types their email, then types the code from the email, or opens its link
 * and lands back here. Or with Microsoft, when an admin set it up. Either way they get a session cookie.
 */
export type Me = Answer<typeof client.api.me.$get>;
/** Today's credits (CreditStatus in server/credits/Credits.ts). */
export type Credits = Me["credits"];

/**
 * Better Auth's client, for signing in and out. It loads when one of those starts, not with
 * the page: a signed-in page reads who is signed in from /api/me alone.
 */
const auth = once(() =>
	Promise.all([import("better-auth/vue"), import("better-auth/client/plugins")]).then(([vue, plugins]) => makeAuthClient(vue, plugins)),
);

function makeAuthClient({ createAuthClient }: typeof import("better-auth/vue"), { adminClient, emailOTPClient, magicLinkClient }: typeof import("better-auth/client/plugins")) {
	return createAuthClient({ plugins: [magicLinkClient(), emailOTPClient(), adminClient()] });
}

/** Undefined while loading, null when signed out. */
export const me = ref<Me | null | undefined>(undefined);
/** Why the last loadMe could not tell who is signed in (offline, or the server failed); empty when it could. */
export const meError = ref("");

/**
 * Asks who is signed in, and returns it. Only a 401 or 403 means signed out. When the server
 * cannot be reached or fails, `me` stays as it was and `meError` says why, so App.vue can offer Retry.
 * The first time, the page itself says, with no request (boot.ts).
 */
export async function loadMe() {
	const booted = fromBoot("me");
	if (booted !== undefined) me.value = booted;
	else await askWhoIsSignedIn();
	if (me.value) keepCachesFor(me.value.user.id);
	return me.value;
}

async function askWhoIsSignedIn() {
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
}

/** Asks again how many credits are left: after each reply, and when a reply is refused. */
export async function refreshCredits() {
	const response = await client.api.credits.$get();
	if (response.ok && me.value) me.value = { ...me.value, credits: await response.json() };
}

/** Sends the email with the link and the code. The page then waits for the code, or for the link to be opened. */
export async function sendSignInLink(email: string) {
	const { error } = await (await auth()).signIn.magicLink({ email, callbackURL: "/", errorCallbackURL: "/?sign-in=failed" });
	if (error) throw new Error(error.message ?? "The email could not be sent.");
}

/**
 * Signs in with the code from the email, then loads who is signed in. `stillWanted` says
 * whether the person still waits for this code: when they chose another email meanwhile, a
 * code that worked is signed out again, and nothing is reported.
 */
export async function signInWithCode(email: string, code: string, stillWanted = () => true) {
	const authClient = await auth();
	const { error } = await authClient.signIn.emailOtp({ email, otp: code });
	if (!stillWanted()) {
		if (!error) await authClient.signOut().catch(() => undefined);
		return;
	}
	if (error) throw new Error(codeErrors[error.code ?? ""] ?? (error.status === 429 ? TOO_FAST : (error.message ?? "Could not sign in.")));
	// The code worked, but who is signed in could not be read: say so, rather than stay on this page with no word.
	if (!(await loadMe())) throw new Error(meError.value ? `${meError.value} Then reload the page.` : "Could not sign in. Reload the page and try again.");
}

/** Where a Microsoft sign-in that failed comes back to: the sign-in page, which says why (SignIn.vue). */
const MICROSOFT_FAILED = "/?sign-in=failed&with=microsoft";

/**
 * Sends the person to Microsoft to sign in (server/auth/microsoft.ts). They come back signed in,
 * to the page they were on. It throws only when Ponder could not send them.
 */
export async function signInWithMicrosoft() {
	const { error } = await (await auth()).signIn.social({ provider: "microsoft", callbackURL: location.pathname + location.search, errorCallbackURL: MICROSOFT_FAILED });
	if (error) throw new Error(error.status === 429 ? TOO_FAST : "Microsoft sign-in is not available now. Try again, or sign in by email.");
}

// Better Auth's codes for a code that did not work (plugins/email-otp/error-codes).
const codeErrors: Record<string, string> = {
	INVALID_OTP: "That code is not right. Check the email and try again.",
	OTP_EXPIRED: "That code has expired. Ask for a new email.",
	TOO_MANY_ATTEMPTS: "Too many wrong codes. Ask for a new email.",
};
const TOO_FAST = "Too many tries. Wait a minute, then try again.";

export async function signOut() {
	await (await auth()).signOut();
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

// The drafts (drafts.ts) are the person's too. "ponder-chat:model" held the model picked
// last, before new chats always started on Auto.
function clearCaches() {
	localStorage.removeItem("ponder-chat:threads");
	localStorage.removeItem("ponder-chat:drafts:v1");
	localStorage.removeItem("ponder-chat:model");
	localStorage.removeItem(CACHE_OWNER);
	indexedDB?.deleteDatabase("ponder-chat");
}
