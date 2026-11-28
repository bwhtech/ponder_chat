import { computed, reactive, ref } from "vue";
import { admin, loadViewer, unwrap, type Settings, type Viewer } from "./api";

/**
 * What the admin pages share: who is signed in, the credit settings (for credits in
 * dollars), the counts in the sidebar, and whether the settings dialog is open. Each
 * page loads its own data.
 */
export const viewer = ref<Viewer | null | undefined>(undefined);
/** What the viewer reaches here: all of /admin ("org"), only the teams they admin ("team"), or nothing (null). */
export const scope = computed(() => viewer.value?.user.adminScope ?? null);
export const settings = reactive<Settings>({ defaultDailyCredits: 0, creditsPerUsd: 1000, pdfTextOnServer: true, compactionModel: "", autoCostTier: "medium" });
export const counts = reactive({ pendingRequests: 0, invited: 0 });
/** The settings dialog, on wider screens. Phones have the Settings page instead. */
export const settingsOpen = ref(false);
/** Offline or a failing server is not "signed out": App.vue says so, with Try again. */
export const viewerError = ref(false);

/** Who opened /admin. Signed out goes to the chat's sign-in page. main.ts asks first, before the app is drawn. */
export async function askViewer() {
	try {
		const loaded = await loadViewer();
		if (!loaded) return location.assign("/");
		viewer.value = loaded;
		viewerError.value = false;
		rememberScope(loaded.user.adminScope);
	} catch {
		viewerError.value = true;
	}
}

export async function refreshCounts() {
	Object.assign(counts, await unwrap(admin.summary.$get()));
}

/**
 * The scope, kept in this browser, so admin.html draws a team admin's frame (only Teams)
 * before the code loads, and nothing moves when the app mounts. It is only a hint: the
 * server checks every call.
 */
function rememberScope(value: string | null) {
	try {
		if (value === "team") localStorage.setItem("ponder-admin-scope", "team");
		else localStorage.removeItem("ponder-admin-scope");
	} catch {
		// Storage can be off, such as in a private window: the frame is then the org admin's.
	}
}
