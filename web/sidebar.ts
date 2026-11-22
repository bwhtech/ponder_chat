import { ref } from "vue";

/**
 * Whether the wide screen's sidebar is folded to its icon rail (ChatsPanel.vue). Kept on this
 * browser, and read before the first draw, so a reload never opens it and folds it again.
 */
const KEY = "ponder-chat:sidebar-collapsed";

export const sidebarCollapsed = ref(read());

export function setSidebarCollapsed(collapsed: boolean) {
	sidebarCollapsed.value = collapsed;
	try {
		localStorage.setItem(KEY, collapsed ? "1" : "0");
	} catch {
		// Private windows and blocked storage: kept until the page loads again.
	}
}

function read() {
	try {
		return localStorage.getItem(KEY) === "1";
	} catch {
		return false;
	}
}
