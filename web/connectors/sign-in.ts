import type { SignInMessage } from "./api";

/**
 * An OAuth sign-in in a popup. The popup opens in the click itself, so the browser does
 * not block it, and is sent to the server's sign-in page once Ponder has its address.
 * The callback page (server/mcp/routes.ts) answers on a BroadcastChannel and to its
 * opener, then closes. Some sign-in pages cut the popup off from its opener
 * (Cross-Origin-Opener-Policy), so the channel is what Ponder relies on.
 *
 * On a phone, and when the popup is blocked, the sign-in uses this tab and comes back to
 * /?settings=connectors (Shell.vue).
 */
const CHANNEL = "ponder-connectors";

/** Phones and installed apps sign in in the same tab: popups open as new tabs there, or not at all. */
const samePage = () => matchMedia("(pointer: coarse)").matches || matchMedia("(display-mode: standalone)").matches;

/** Opens an empty popup now, in the click. Null when this device signs in in the same tab, or the popup was blocked. */
export function openSignInWindow(): Window | null {
	if (samePage()) return null;
	const width = 520;
	const height = 720;
	const left = Math.max(0, screenX + (outerWidth - width) / 2);
	const top = Math.max(0, screenY + (outerHeight - height) / 3);
	return open("about:blank", "ponder-connector-sign-in", `popup,width=${width},height=${height},left=${left},top=${top}`);
}

/** Sends the popup to the sign-in page, or this tab when there is no popup. */
export function goToSignIn(popup: Window | null, authorizeUrl: string) {
	if (popup && !popup.closed) popup.location.href = authorizeUrl;
	else location.assign(authorizeUrl);
}

/** How a wait for the callback page ends. */
export type SignInEnd =
	// The callback page answered for this sign-in.
	| { kind: "answered"; message: SignInMessage }
	// The signal aborted: the person pressed Cancel, closed the dialog or started again.
	| { kind: "cancelled" }
	// The popup closed before the callback page answered.
	| { kind: "closed" };

type WaitOptions = {
	/** Where the popup went. Its OAuth state is how the callback page names this sign-in. */
	authorizeUrl: string;
	/** The connector, when it already exists (a new sign-in for it). */
	id?: string;
	/** Aborting it stops the wait and closes the popup. */
	signal?: AbortSignal;
	/** An answer that comes after the popup seemed to close. See below. */
	onLate?: (message: SignInMessage) => void;
};

/** How long the sign-in waits on the server (server/mcp/store.ts): after that no answer can come. */
const SIGN_IN_LIFETIME = 10 * 60_000;

/**
 * Waits for the callback page of this sign-in, and only this one: another tab or an
 * older sign-in may answer on the same channel. Ponder looks at the popup twice a second,
 * so closing it ends the wait.
 *
 * A sign-in page that cuts the popup off from its opener also makes the popup look closed
 * from here, while the person is still signing in. So after "closed" the channel listens
 * on, until the sign-in expires or the signal aborts, and gives a late answer to `onLate`.
 */
export function waitForSignIn(popup: Window, options: WaitOptions): Promise<SignInEnd> {
	const state = new URL(options.authorizeUrl, location.href).searchParams.get("state");
	const channel = new BroadcastChannel(CHANNEL);
	let settle: (end: SignInEnd) => void = () => undefined;
	const result = new Promise<SignInEnd>((resolve) => (settle = resolve));
	let settled = false;
	let closedOnce = false;

	// The OAuth state names the sign-in. A connector's id is the fallback, for an answer with no state.
	const mine = (message: SignInMessage) => {
		if (state && message.state) return message.state === state;
		if (options.id && message.id) return message.id === options.id;
		return true;
	};
	const onMessage = (event: MessageEvent) => {
		if (event instanceof MessageEvent && event.origin && event.origin !== location.origin) return;
		const data = event.data as SignInMessage | undefined;
		if (data?.type !== "ponder:connector-sign-in" || !mine(data)) return;
		if (settled) options.onLate?.(data);
		else end({ kind: "answered", message: data });
		stop();
	};
	// The callback page posts, then closes: one more look gives its answer time to arrive.
	const poll = setInterval(() => {
		if (!popup.closed) return void (closedOnce = false);
		if (!closedOnce) return void (closedOnce = true);
		clearInterval(poll);
		end({ kind: "closed" });
		if (!options.onLate) stop();
	}, 500);
	const expire = setTimeout(() => {
		end({ kind: "closed" });
		stop();
	}, SIGN_IN_LIFETIME);
	const onAbort = () => {
		popup.close();
		end({ kind: "cancelled" });
		stop();
	};

	function end(value: SignInEnd) {
		if (settled) return;
		settled = true;
		settle(value);
	}
	function stop() {
		clearInterval(poll);
		clearTimeout(expire);
		channel.close();
		removeEventListener("message", onMessage);
		options.signal?.removeEventListener("abort", onAbort);
	}

	channel.addEventListener("message", onMessage);
	addEventListener("message", onMessage);
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort);
	return result;
}
