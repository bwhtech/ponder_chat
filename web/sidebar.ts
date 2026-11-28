import { onBeforeUnmount, ref, watch, type Ref } from "vue";

/**
 * Whether the wide screen's sidebar is folded to its icon rail (ChatsPanel.vue). Kept on this
 * browser, and read before the first draw, so a reload never opens it and folds it again.
 */
const KEY = "ponder-chat:sidebar-collapsed";
const PEEK_OPEN_MS = 80;
const PEEK_CLOSE_MS = 160;

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

/**
 * The folded sidebar's preview: a mouse on the rail's top icon slides the full sidebar over the
 * page, and it leaves with the pointer. A row's menu opens outside the panel, so an open menu, or
 * a text field in use, holds it until they are done.
 */
export function useSidebarPeek(panel: Ref<HTMLElement | null>) {
	const peeking = ref(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => clearTimeout(timer);
	const after = (ms: number, run: () => void) => {
		stop();
		timer = setTimeout(run, ms);
	};
	const menuOpen = () => document.querySelector('[role="menu"][data-state="open"]') !== null;
	const typing = () => Boolean(panel.value?.contains(document.activeElement) && document.activeElement?.matches("input, textarea"));
	function close() {
		if (menuOpen() || typing()) after(PEEK_CLOSE_MS, close);
		else peeking.value = false;
	}
	function onKeydown(event: KeyboardEvent) {
		if (event.key !== "Escape" || !peeking.value || menuOpen()) return;
		stop();
		peeking.value = false;
	}
	addEventListener("keydown", onKeydown);
	onBeforeUnmount(() => {
		stop();
		removeEventListener("keydown", onKeydown);
	});
	watch(sidebarCollapsed, () => {
		stop();
		peeking.value = false;
	});
	return {
		peeking,
		enterIcon: (event: PointerEvent) => event.pointerType === "mouse" && after(PEEK_OPEN_MS, () => (peeking.value = true)),
		leaveIcon: () => peeking.value || stop(),
		enterPanel: () => peeking.value && stop(),
		leavePanel: () => (peeking.value ? after(PEEK_CLOSE_MS, close) : stop()),
	};
}
