import { ref } from "vue";

/**
 * The card that the sidebar shows in place of its workspaces while the person has none
 * (WorkspaceIntro.vue). Its × hides it on this browser; the plain "New workspace" row stays.
 * Only a convenience, so a browser that keeps no storage shows the card each time.
 */
const KEY = "ponder-chat:workspace-intro:hidden";

export const introHidden = ref(read());

export function hideIntro() {
	introHidden.value = true;
	try {
		localStorage.setItem(KEY, "1");
	} catch {
		// Private windows and blocked storage: hidden until the page loads again.
	}
}

function read() {
	try {
		return localStorage.getItem(KEY) === "1";
	} catch {
		return false;
	}
}
