import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useState } from "react";
import { useStore } from "../lib/store";
import { toast, toastError } from "../lib/toast";
import { settings, showConnector } from "../settings/state";
import { removing } from "./actions";
import { removeConnector } from "./api";

/** "Remove Linear?": asked before a connector goes, from its row or its page. */
export default function RemoveConnectorDialog() {
	const connector = useStore(removing);
	const [busy, setBusy] = useState(false);

	async function remove() {
		if (!connector) return;
		setBusy(true);
		try {
			await removeConnector(connector.id);
			toast(`Removed ${connector.name}`);
			removing.set(null);
			// Its page closes with it.
			if (settings.get()?.connector === connector.id) showConnector(null);
		} catch (error) {
			toastError(error instanceof Error ? error.message : "The connector was not removed.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<AlertDialog
			isOpen={Boolean(connector)}
			onOpenChange={(isOpen) => !isOpen && !busy && removing.set(null)}
			title={connector ? `Remove ${connector.name}?` : ""}
			description={connector ? `Ponder forgets its sign-in and its tools. Chats keep what ${connector.name} already returned.` : ""}
			actionLabel="Remove"
			isActionLoading={busy}
			onAction={remove}
		/>
	);
}
