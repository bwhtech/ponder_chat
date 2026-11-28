import { reactive } from "vue";
import { credits } from "../numbers";

/**
 * Where Settings is: open or not, which tab, and which connector's page. Kept here so
 * the chat (a connector that needs a new sign-in, a memory note under a reply) and the
 * account menu can open it.
 */
export type SettingsTab = "account" | "memory" | "teams" | "connectors";

/** Settings' tabs, in the dialog's sidebar (SettingsModal.vue) and in its stand-in (SettingsPlaceholder.vue). */
export const SETTINGS_TABS: { value: SettingsTab; label: string; icon: string }[] = [
	{ value: "account", label: "Account", icon: "lucide-circle-user" },
	{ value: "memory", label: "Memory", icon: "lucide-brain" },
	{ value: "teams", label: "Teams", icon: "lucide-users-round" },
	{ value: "connectors", label: "Connectors", icon: "lucide-plug" },
];

/** The Memory tab's first lines, in the tab (MemoryPanel.vue) and in its stand-in. */
export const MEMORY_INTRO =
	"Ponder remembers what you tell it about yourself, your work and how you like answers, and uses it in new chats so you don't have to repeat yourself. It never keeps passwords, contact details, ID numbers, health details, or what you say about other people.";

/** The Teams tab's first line, in the tab (TeamsPanel.vue) and in its stand-in. */
export const TEAMS_INTRO = "The teams you are in, and who else is in them. A workspace shared with a team is shared with each person in it.";

/** The Memory tab's own tabs, in the tab and in its stand-in. */
export const MEMORY_TABS = [
	{ value: "memories", label: "Memories" },
	{ value: "decisions", label: "Decisions" },
	{ value: "prompt", label: "How it decides" },
];

export const settings = reactive({ open: false, tab: "account" as SettingsTab, connector: null as string | null });

export function openSettings(tab: SettingsTab = "account", connector: string | null = null) {
	Object.assign(settings, { open: true, tab, connector });
}

/** The Account tab's line about daily credits, in the tab (AccountPanel.vue) and in its stand-in while Settings loads. */
export function creditsNote({ limit, extra }: { limit: number; extra: number }) {
	const today = extra ? ` Today you also have ${credits(extra)} extra credits from an admin.` : "";
	return `You get ${credits(limit - extra)} credits a day. Each reply uses credits by what the model charges for it, so bigger models use more. Credits refill at midnight UTC.${today}`;
}
