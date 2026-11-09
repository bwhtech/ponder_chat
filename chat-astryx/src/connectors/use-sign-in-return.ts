import { useEffect } from "react";
import { toast, toastError } from "../lib/toast";
import { openSettings } from "../settings/state";
import { loadConnectors } from "./api";

/**
 * Back from a connector's sign-in in this tab (a phone): /?settings=connectors&connector=<id>,
 * or &connector_error=<why> (server/mcp/routes.ts). Opens the connector, then tidies the URL.
 */
export function useSignInReturn() {
	useEffect(() => {
		const back = new URL(location.href);
		if (back.searchParams.get("settings") !== "connectors") return;
		const id = back.searchParams.get("connector");
		const problem = back.searchParams.get("connector_error");
		for (const key of ["settings", "connector", "connector_error"]) back.searchParams.delete(key);
		history.replaceState(history.state, "", back);
		openSettings("connectors", id);
		// After this render: App connects the toasts in an effect that runs after this one.
		if (problem) setTimeout(() => toastError(problem));
		else if (id) void loadConnectors().then(() => toast("Connected"), () => undefined);
	}, []);
}
