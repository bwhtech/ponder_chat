import type { dialog as frappeDialog } from "frappe-ui";
import { ref, shallowRef } from "vue";
import { once } from "./once";

type Dialog = typeof frappeDialog;
type ConfirmArgs = Parameters<Dialog["confirm"]>[0];
type PromptArgs = Parameters<Dialog["prompt"]>[0];
type DangerArgs = Parameters<Dialog["danger"]>[0];

/**
 * frappe-ui's dialog.confirm, .prompt and .danger, loaded the first time one opens. Its
 * module brings every kind of form field (the date, time and multi-select pickers among
 * them), which the first page never shows. App.vue mounts the dialogs' host once
 * `dialogsWanted` is true. Use these, not frappe-ui's own, so the host is there.
 */
export const dialogsWanted = ref(false);
export const loadDialogs = once(() => import("./dialogs-host"));

/**
 * A dialog asked for while that code is still on its way. Workspace.vue draws it meanwhile
 * (DialogPlaceholder.vue): its title, message and buttons, or its fields' labels.
 */
export type PendingDialog = { kind: "confirm"; args: ConfirmArgs } | { kind: "danger"; args: DangerArgs } | { kind: "prompt"; args: PromptArgs };
export const pendingDialog = shallowRef<PendingDialog | null>(null);
let loaded: Dialog | undefined;

export const dialog = {
	confirm: (args: ConfirmArgs) => open({ kind: "confirm", args }),
	prompt: (args: PromptArgs) => open({ kind: "prompt", args }),
	danger: (args: DangerArgs) => open({ kind: "danger", args }),
};

function open(request: PendingDialog) {
	dialogsWanted.value = true;
	if (loaded) return show(loaded, request);
	pendingDialog.value = request;
	void loadDialogs().then(
		(module) => {
			loaded = module.dialog;
			// Closed while it loaded, or replaced by a newer one.
			if (pendingDialog.value !== request) return;
			pendingDialog.value = null;
			show(module.dialog, request);
		},
		// Offline: the stand-in goes, and the next try loads it again.
		() => pendingDialog.value === request && (pendingDialog.value = null),
	);
}

/** The person closed the dialog before its code came: as Cancel would. */
export function cancelPendingDialog() {
	const request = pendingDialog.value;
	pendingDialog.value = null;
	void request?.args.onCancel?.();
}

function show(dialogs: Dialog, request: PendingDialog) {
	if (request.kind === "prompt") dialogs.prompt(request.args);
	else if (request.kind === "danger") dialogs.danger(request.args);
	else dialogs.confirm(request.args);
}
