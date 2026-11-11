import { emailOTPClient, magicLinkClient, adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { model } from "./models";
import { createStore } from "./store";

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
export const me = createStore<Me | null | undefined>(undefined);
/** Why the last loadMe could not tell who is signed in (offline, or the server failed); empty when it could. */
export const meError = createStore("");

/**
 * Asks who is signed in, and returns it. Only a 401 or 403 means signed out. When the server
 * cannot be reached or fails, `me` stays as it was and `meError` says why, so App can offer Retry.
 */
export async function loadMe() {
	try {
		const response = await fetch("/api/me");
		if (response.status === 401 || response.status === 403) me.set(null);
		else if (!response.ok) throw new Error(`The server answered ${response.status}.`);
		else me.set(await response.json());
		meError.set("");
	} catch {
		meError.set("Ponder Chat could not reach the server. Check your connection, then try again.");
	}
	const current = me.get();
	if (current) keepCachesFor(current.user.id);
	return current;
}

/** Asks again how many credits are left: after each reply, and when a reply is refused. */
export async function refreshCredits() {
	const response = await fetch("/api/credits");
	const current = me.get();
	if (response.ok && current) me.set({ ...current, credits: await response.json() });
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
	if (!(await loadMe())) {
		const why = meError.get();
		throw new Error(why ? `${why} Then reload the page.` : "Could not sign in. Reload the page and try again.");
	}
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

/** People have no name until they set one, so the start of the email stands in. */
export function displayName(current: Me | null | undefined) {
	return current?.user.name.trim() || current?.user.email.split("@")[0] || "";
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
	localStorage.removeItem("ponder-chat:drafts:v1");
	localStorage.removeItem("ponder-chat:model");
	model.set("");
	localStorage.removeItem(CACHE_OWNER);
	indexedDB?.deleteDatabase("ponder-chat");
}
