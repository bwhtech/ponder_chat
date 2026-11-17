import { reactive, ref } from "vue";
import type { WorkspaceDetail } from "./store";

/**
 * The workspace dialogs: New workspace, Edit details and Share (WorkspaceDialogs.vue). Their
 * code loads the first time one opens; meanwhile the shell draws the dialog's frame and fields
 * (WorkspaceDialogPlaceholder.vue), as it does for Settings. `request` stays after closing, so
 * the dialog can play its closing transition.
 */
export type WorkspaceDialogRequest =
	| { kind: "new" }
	| { kind: "edit"; workspace: WorkspaceDetail; onSaved: (workspace: WorkspaceDetail) => void }
	| { kind: "share"; workspace: WorkspaceDetail; onSaved: (workspace: WorkspaceDetail) => void };

/** `serial` goes up with each request, so a dialog opened again starts from its workspace, not from what was typed before. */
export const workspaceDialog = reactive({ open: false, serial: 0, request: null as WorkspaceDialogRequest | null });
/** A workspace dialog opened once: the shell keeps its code mounted from then on. */
export const workspaceDialogUsed = ref(false);

export function openWorkspaceDialog(request: WorkspaceDialogRequest) {
	workspaceDialog.request = request;
	workspaceDialog.serial++;
	workspaceDialog.open = true;
	workspaceDialogUsed.value = true;
}

export function closeWorkspaceDialog() {
	workspaceDialog.open = false;
}

/** Who can use a workspace, as the dialogs offer it to an admin. */
export const KIND_OPTIONS = [
	{ label: "Only the people you add", value: "private" },
	{ label: "Everyone in the organisation", value: "org" },
];

/** The dialog's title, in the dialog and in its stand-in. */
export function dialogTitle(request: WorkspaceDialogRequest) {
	if (request.kind === "new") return "New workspace";
	if (request.kind === "edit") return "Edit workspace";
	return `Share “${request.workspace.name}”`;
}
