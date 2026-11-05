import { reactive } from "vue";

/**
 * Where Settings is: open or not, which tab, and which connector's page. Kept here so
 * the chat (a connector that needs a new sign-in) and the account menu can open it.
 */
export type SettingsTab = "account" | "connectors";

export const settings = reactive({ open: false, tab: "account" as SettingsTab, connector: null as string | null });

export function openSettings(tab: SettingsTab = "account", connector: string | null = null) {
	Object.assign(settings, { open: true, tab, connector });
}
