import { createAuthClient } from "better-auth/vue";
import { magicLinkClient } from "better-auth/client/plugins";
import { ref } from "vue";

/**
 * Who is signed in, and their credits for today. Sign-in is a magic link
 * (server/auth.ts): the person types their email, opens the link, and lands back here
 * with a session cookie.
 */
export type Credits = { limit: number; used: number; remaining: number; resetsAt: string };
export type Me = { user: { id: string; email: string; name: string }; credits: Credits };

export const authClient = createAuthClient({ plugins: [magicLinkClient()] });

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

/** Sends the link. The page waits for the person to open it from their email. */
export async function sendSignInLink(email: string) {
	const { error } = await authClient.signIn.magicLink({ email, callbackURL: "/", errorCallbackURL: "/?sign-in=failed" });
	if (error) throw new Error(error.message ?? "The link could not be sent.");
}

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
