import type { SignInMessage } from "./api";

/**
 * An OAuth sign-in in a popup. The popup opens in the click itself, so the browser does
 * not block it, and is sent to the server's sign-in page once Ponder has its address.
 * The callback page (server/mcp/routes.ts) answers on a BroadcastChannel and to its
 * opener, then closes. Some sign-in pages cut the popup off from its opener
 * (Cross-Origin-Opener-Policy), so the channel is what Ponder relies on.
 *
 * On a phone, and when the popup is blocked, the sign-in uses this tab and comes back to
 * /?settings=connectors (Workspace.vue).
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

/** Waits for the callback page. `cancel` stops waiting (the person pressed Cancel) and closes the popup. */
export function waitForSignIn(popup: Window | null): { result: Promise<SignInMessage | null>; cancel: () => void } {
	const channel = new BroadcastChannel(CHANNEL);
	let finish: (message: SignInMessage | null) => void = () => undefined;
	const result = new Promise<SignInMessage | null>((resolve) => (finish = resolve));
	const onMessage = (event: MessageEvent) => {
		if (event instanceof MessageEvent && event.origin && event.origin !== location.origin) return;
		const data = event.data as SignInMessage | undefined;
		if (data?.type === "ponder:connector-sign-in") done(data);
	};
	function done(message: SignInMessage | null) {
		channel.close();
		removeEventListener("message", onMessage);
		finish(message);
	}
	channel.addEventListener("message", onMessage);
	addEventListener("message", onMessage);
	return {
		result,
		cancel: () => {
			popup?.close();
			done(null);
		},
	};
}
