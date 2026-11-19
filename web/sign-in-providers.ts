import { reactive } from "vue";
import { fromBoot } from "./boot";
import { isRecord } from "./json";

/**
 * The ways to sign in besides email: Microsoft, when an admin set it up (server/auth/microsoft.ts).
 * The chat page has it in its boot data, so the sign-in page draws its button at once;
 * `npm run dev` asks GET /api/sign-in.
 */
export const signInWith = reactive({ microsoft: false });

let loading: Promise<void> | undefined;

/** Reads them, once. Never fails: without an answer the page offers sign-in by email only. */
export function loadSignInProviders() {
	loading ??= (async () => {
		const boot = fromBoot("signIn");
		if (boot) return void Object.assign(signInWith, { microsoft: boot.microsoft });
		try {
			const response = await fetch("/api/sign-in");
			const body: unknown = response.ok ? await response.json() : undefined;
			if (isRecord(body)) signInWith.microsoft = body.microsoft === true;
		} catch {
			// Offline: sign-in by email, which the page has already.
		}
	})();
	return loading;
}
