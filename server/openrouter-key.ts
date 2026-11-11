import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { openRouterUrl } from "./openrouter.ts";
import { readSecret, saveSecret, secretInfo, UnreadableSecret } from "./secrets.ts";

/**
 * The OpenRouter API key that every call uses: replies, thread names, memory, embeddings
 * and web search. Admins set it on /admin, Settings, where it is saved encrypted
 * (secrets.ts). Until one is saved there, OPENROUTER_API_KEY from the environment is used.
 *
 * The decrypted key is kept in memory for a minute. A change from /admin applies at once
 * in this process.
 */
const NAME = "openrouter_api_key";
const CACHE_MS = 60_000;
const CHECK_URL = openRouterUrl("v1/key");
let cached: { key: string; at: number } | undefined;

export async function openRouterKey(): Promise<string> {
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.key;
	const key = (await savedKey()) ?? process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error("There is no OpenRouter key. An admin can add one in /admin, Settings.");
	cached = { key, at: Date.now() };
	return key;
}

/** An OpenRouter provider with the current key. Make one for each call, because the key can change. */
export async function openRouter() {
	return createOpenRouter({ apiKey: await openRouterKey(), baseURL: openRouterUrl("v1") });
}

export type KeyStatus = {
	/** Where the key in use comes from: Settings, the environment, or nowhere. */
	source: "settings" | "environment" | "none";
	/** The key's last characters, such as "…3f9a", so admins can tell keys apart. */
	hint: string | null;
	/** The saved key can't be decrypted, because BETTER_AUTH_SECRET changed. */
	unreadable: boolean;
	updatedAt: Date | null;
	updatedBy: string | null;
};

/** For /admin. Never the key itself. */
export async function openRouterKeyStatus(): Promise<KeyStatus> {
	const info = await secretInfo(NAME);
	if (info) {
		const saved = await readSecret(NAME).catch((error) => {
			if (error instanceof UnreadableSecret) return undefined;
			throw error;
		});
		return { source: "settings", hint: saved ? hint(saved) : null, unreadable: !saved, ...info };
	}
	const env = process.env.OPENROUTER_API_KEY;
	return { source: env ? "environment" : "none", hint: env ? hint(env) : null, unreadable: false, updatedAt: null, updatedBy: null };
}

/** Asks OpenRouter whether the key works, before it is saved. Returns why not, or null. */
export async function checkOpenRouterKey(key: string): Promise<string | null> {
	try {
		const response = await fetch(CHECK_URL, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
		if (response.ok) return null;
		if (response.status === 401 || response.status === 403) return "OpenRouter did not accept this key.";
		return `OpenRouter could not check the key (HTTP ${response.status}). Try again.`;
	} catch {
		return "Could not reach OpenRouter to check the key. Try again.";
	}
}

export async function saveOpenRouterKey(key: string, by: string) {
	await saveSecret(NAME, key, by);
	cached = { key, at: Date.now() };
}

/** The saved key, or undefined. An unreadable one is logged, and the environment's key is used instead. */
async function savedKey() {
	try {
		return await readSecret(NAME);
	} catch (error) {
		if (!(error instanceof UnreadableSecret) || !process.env.OPENROUTER_API_KEY) throw error;
		console.error(`${error.message} Using OPENROUTER_API_KEY meanwhile.`);
		return undefined;
	}
}

function hint(key: string) {
	return key.length > 12 ? `…${key.slice(-4)}` : "…";
}
