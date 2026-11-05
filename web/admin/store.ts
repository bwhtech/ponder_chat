import { reactive, ref } from "vue";
import { api, type Settings, type Viewer } from "./api";

/**
 * What the admin pages share: who is signed in, the credit settings (for credits in
 * dollars), and the counts in the sidebar. Each page loads its own data.
 */
export const viewer = ref<Viewer | null | undefined>(undefined);
export const settings = reactive<Settings>({ defaultDailyCredits: 0, creditsPerUsd: 1000 });
export const counts = reactive({ pendingRequests: 0, invited: 0 });

export async function refreshCounts() {
	Object.assign(counts, await api<typeof counts>("/summary"));
}
