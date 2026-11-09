import { createStore } from "../lib/store";

/** The Settings dialog: closed, or open on a tab. Stub until it is ported. */
export type SettingsTab = "account" | "connectors" | "skills";

export const settings = createStore<{ tab: SettingsTab; connector?: string | null } | null>(null);

export function openSettings(tab: SettingsTab = "account", connector: string | null = null) {
	settings.set({ tab, connector });
}

export function closeSettings() {
	settings.set(null);
}
