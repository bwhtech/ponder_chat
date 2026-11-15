import { computed, nextTick, ref, shallowRef, watch, type Component } from "vue";
import { once } from "./once";

/**
 * frappe-ui's Dropdown, loaded when a menu is first about to open. With reka-ui's menu parts,
 * frappe-ui's Menu and their positioning, it is about 45 KB that the first page does not
 * need. Set once it has loaded.
 */
export const Dropdown = shallowRef<Component>();
const loadDropdown = once(() => import("./dropdown").then((module) => (Dropdown.value = module.Dropdown)));

/**
 * A menu that shows a plain button until it is `armed` (pointed at, touched or focused, before
 * the press that opens it), then loads the Dropdown and draws it in the button's place
 * (ThreadMenu.vue, AccountMenu.vue). `shown` says which of the two is drawn. Put
 * `ref="plain"` on the plain button and `ref="trigger"` on the Dropdown's.
 */
export function useLazyMenu(armed: () => boolean) {
	const plain = ref<HTMLElement | null>(null);
	const trigger = ref<HTMLElement | null>(null);
	const open = ref(false);
	const shown = computed(() => armed() && Boolean(Dropdown.value));
	watch(armed, (now) => now && void loadDropdown().catch(() => undefined), { immediate: true });
	// Shift+Tab can land on the plain button first, and the menu's own button takes its place: the focus follows.
	watch(
		shown,
		(now) => {
			if (now && document.activeElement === plain.value) void nextTick(() => trigger.value?.focus());
		},
		{ flush: "pre" },
	);
	return { Dropdown, shown, open, plain, trigger };
}
