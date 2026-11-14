import { toast } from "frappe-ui";
import { dialog } from "../dialogs";
import { loadConnectors, removeConnector, startSignIn, type Connector, type SignInMessage } from "./api";
import { goToSignIn, openSignInWindow, waitForSignIn } from "./sign-in";

/** The sign-in in progress, so a second click does not start another. Its popup is null when this tab signs in. */
let current: { popup: Window | null; stop: AbortController } | undefined;

/** A new OAuth sign-in for a connector whose sign-in ended. Call it in the click, so the popup is allowed. */
export async function signInAgain(connector: Connector) {
	// Still signing in: show that window. The popup has one name, so opening another would blank it.
	if (current && !(current.popup?.closed ?? false)) return void current.popup?.focus();
	// A closed popup's wait may still listen for a late answer (sign-in.ts). This sign-in replaces it.
	current?.stop.abort();
	const popup = openSignInWindow();
	const attempt = { popup, stop: new AbortController() };
	current = attempt;
	try {
		const { authorizeUrl } = await startSignIn(connector.id);
		if (attempt.stop.signal.aborted) return;
		goToSignIn(popup, authorizeUrl);
		// No popup: this tab goes to the sign-in page, so there is nothing to wait for.
		if (!popup) return;
		toast.info(`Sign in to ${connector.name} in the new window.`);
		const end = await waitForSignIn(popup, {
			authorizeUrl,
			id: connector.id,
			signal: attempt.stop.signal,
			onLate: (message) => void signedIn(connector, message),
		});
		if (end.kind === "answered") await signedIn(connector, end.message);
		// "closed" keeps `current`, so the next sign-in stops the wait that still listens.
		if (end.kind !== "closed" && current === attempt) current = undefined;
	} catch (error) {
		popup?.close();
		if (current === attempt) current = undefined;
		toast.error(error instanceof Error ? error.message : "The sign-in did not start.");
	}
}

async function signedIn(connector: Connector, message: SignInMessage) {
	if (!message.ok) return void toast.error(message.error ?? "The sign-in did not finish.");
	// The list shows its own error when it does not load (ConnectorsPanel.vue).
	await loadConnectors().catch(() => undefined);
	toast.success(`Signed in to ${connector.name}`);
}

/** Asks first. Resolves true when the connector was removed. */
export function confirmRemove(connector: Connector): Promise<boolean> {
	return new Promise((resolve) => {
		dialog.danger({
			title: `Remove ${connector.name}?`,
			message: `Ponder forgets its sign-in and its tools. Chats keep what ${connector.name} already returned.`,
			confirmLabel: "Remove",
			onConfirm: async () => {
				await removeConnector(connector.id);
				toast.success(`Removed ${connector.name}`);
				resolve(true);
			},
			onCancel: () => resolve(false),
		});
	});
}
