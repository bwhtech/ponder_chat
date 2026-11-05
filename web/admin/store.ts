import { reactive, ref } from "vue";
import { api, type Settings, type Viewer } from "./api";

/**
 * What the admin pages share: who is signed in, the credit settings (for credits in
 * dollars), the counts in the sidebar, and whether the settings dialog is open. Each
 * page loads its own data.
 */
export const viewer = ref<Viewer | null | undefined>(undefined);
export const settings = reactive<Settings>({ defaultDailyCredits: 0, creditsPerUsd: 1000, pdfTextOnServer: true });
export const counts = reactive({ pendingRequests: 0, invited: 0 });
/** The settings dialog, on wider screens. Phones have the Settings page instead. */
export const settingsOpen = ref(false);

export async function refreshCounts() {
	Object.assign(counts, await api<typeof counts>("/summary"));
}
