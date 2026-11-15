import { reactive } from "vue";
import { credits } from "../numbers";

/**
 * Where Settings is: open or not, which tab, and which connector's page. Kept here so
 * the chat (a connector that needs a new sign-in) and the account menu can open it.
 */
export type SettingsTab = "account" | "connectors";

export const settings = reactive({ open: false, tab: "account" as SettingsTab, connector: null as string | null });

export function openSettings(tab: SettingsTab = "account", connector: string | null = null) {
	Object.assign(settings, { open: true, tab, connector });
}

/** The Account tab's line about daily credits, in the tab (AccountPanel.vue) and in its stand-in while Settings loads. */
export function creditsNote({ limit, extra }: { limit: number; extra: number }) {
	const today = extra ? ` Today you also have ${credits(extra)} extra credits from an admin.` : "";
	return `You get ${credits(limit - extra)} credits a day. Each reply uses credits by what the model charges for it, so bigger models use more. Credits refill at midnight UTC.${today}`;
}
