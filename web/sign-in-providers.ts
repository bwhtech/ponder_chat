import { reactive } from "vue";
import { fromBoot } from "./boot";
import { isRecord } from "./json";

/**
 * The ways to sign in: Microsoft, when an admin set it up (server/auth/microsoft.ts), and email
 * unless an admin turned it off (server/auth/SignInProviders.ts). The chat page has them in its
 * boot data, so the sign-in page draws its buttons at once; `npm run dev` asks GET /api/sign-in.
 */
export const signInWith = reactive({ microsoft: false, email: true });

let loading: Promise<void> | undefined;

/** Reads them, once. Never fails: without an answer the page offers sign-in by email only. */
export function loadSignInProviders() {
	loading ??= (async () => {
		const boot = fromBoot("signIn");
		if (boot) return void Object.assign(signInWith, { microsoft: boot.microsoft, email: boot.email });
		try {
			const response = await fetch("/api/sign-in");
			const body: unknown = response.ok ? await response.json() : undefined;
			if (!isRecord(body)) return;
			signInWith.microsoft = body.microsoft === true;
			// Email is off only with Microsoft on: there is always a way in.
			signInWith.email = body.email !== false || !signInWith.microsoft;
		} catch {
			// Offline: sign-in by email, which the page has already.
		}
	})();
	return loading;
}
