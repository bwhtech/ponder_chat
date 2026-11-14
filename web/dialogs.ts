import type { dialog as frappeDialog } from "frappe-ui";
import { ref } from "vue";
import { once } from "./once";

type Dialog = typeof frappeDialog;

/**
 * frappe-ui's dialog.confirm, .prompt and .danger, loaded the first time one opens. Its
 * module brings every kind of form field (the date, time and multi-select pickers among
 * them), which the first page never shows. App.vue mounts the dialogs' host once
 * `dialogsWanted` is true. Use these, not frappe-ui's own, so the host is there.
 */
export const dialogsWanted = ref(false);
export const loadDialogs = once(() => import("./dialogs-host"));

export const dialog = {
	confirm: (...args: Parameters<Dialog["confirm"]>) => open((dialogs) => dialogs.confirm(...args)),
	prompt: (...args: Parameters<Dialog["prompt"]>) => open((dialogs) => dialogs.prompt(...args)),
	danger: (...args: Parameters<Dialog["danger"]>) => open((dialogs) => dialogs.danger(...args)),
};

function open(show: (dialogs: Dialog) => void) {
	dialogsWanted.value = true;
	void loadDialogs().then((module) => show(module.dialog));
}
