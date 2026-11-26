import { reactive } from "vue";

/**
 * Where Settings is: open or not, which tab, and which connector's page. Kept here so
 * the chat (a connector that needs a new sign-in, a memory note under a reply) and the
 * account menu can open it.
 */
export type SettingsTab = "account" | "usage" | "memory" | "connectors";

/** Settings' tabs, in the dialog's sidebar (SettingsModal.vue) and in its stand-in (SettingsPlaceholder.vue). */
export const SETTINGS_TABS: { value: SettingsTab; label: string; icon: string }[] = [
	{ value: "account", label: "Account", icon: "lucide-circle-user" },
	{ value: "usage", label: "Usage", icon: "lucide-gauge" },
	{ value: "memory", label: "Memory", icon: "lucide-brain" },
	{ value: "connectors", label: "Connectors", icon: "lucide-plug" },
];

/** The Usage tab's first line, in the tab (UsagePanel.vue) and in its stand-in. */
export const USAGE_INTRO = "Your credits today, and what used them over the last 30 days.";

/** The Memory tab's first lines, in the tab (MemoryPanel.vue) and in its stand-in. */
export const MEMORY_INTRO =
	"Ponder remembers what you tell it about yourself, your work and how you like answers, and uses it in new chats so you don't have to repeat yourself. It never keeps passwords, contact details, ID numbers, health details, or what you say about other people.";

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
