import { dialog, toast } from "frappe-ui";
import { loadConnectors, removeConnector, startSignIn, type Connector } from "./api";
import { goToSignIn, openSignInWindow, waitForSignIn } from "./sign-in";

/** A new OAuth sign-in for a connector whose sign-in ended. Call it in the click, so the popup is allowed. */
export async function signInAgain(connector: Connector) {
	const popup = openSignInWindow();
	try {
		const { authorizeUrl } = await startSignIn(connector.id);
		goToSignIn(popup, authorizeUrl);
		if (!popup) return;
		const waiting = waitForSignIn(popup);
		toast.info(`Sign in to ${connector.name} in the new window.`);
		const message = await waiting.result;
		if (!message) return;
		if (!message.ok) return void toast.error(message.error ?? "The sign-in did not finish.");
		await loadConnectors();
		toast.success(`Signed in to ${connector.name}`);
	} catch (error) {
		popup?.close();
		toast.error(error instanceof Error ? error.message : "The sign-in did not start.");
	}
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

/** "5 minutes ago". */
export function ago(iso: string | null) {
	if (!iso) return "never";
	const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
	const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
	for (const [unit, size] of units) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
	return "just now";
}
