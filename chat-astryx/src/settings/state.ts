import { createStore } from "../lib/store";

/**
 * Where Settings is: closed, or open on a tab, with a connector's page or the Add connector
 * steps open on Connectors. Kept here so the chat (a connector that needs a new sign-in)
 * and the account menu can open it.
 */
export type SettingsTab = "account" | "connectors";
export type SettingsPlace = { tab: SettingsTab; connector?: string | null; adding?: boolean };

export const settings = createStore<SettingsPlace | null>(null);

export function openSettings(tab: SettingsTab = "account", connector: string | null = null) {
	settings.set({ tab, connector });
}

export function closeSettings() {
	settings.set(null);
}

/** Cmd+Shift+, (Ctrl+Shift+,) opens Settings, or closes it. */
export function toggleSettings() {
	settings.set((place) => (place ? null : { tab: "account" }));
}

/** A connector's page on Connectors, or the list when null. */
export function showConnector(id: string | null) {
	settings.set({ tab: "connectors", connector: id });
}

/** The Add connector steps on Connectors. */
export function showAddConnector() {
	settings.set({ tab: "connectors", adding: true });
}
