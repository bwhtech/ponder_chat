import { nextTick, onMounted, reactive, ref } from "vue";
import type { WorkspaceDocument } from "./documents";
import type { WorkspaceDetail } from "./store";

/**
 * The workspace dialogs: New workspace, Instructions, Share and a document's Details (WorkspaceDialogs.vue). Their
 * code loads the first time one opens; meanwhile the shell draws the dialog's frame and fields
 * (WorkspaceDialogPlaceholder.vue), as it does for Settings. `request` stays after closing, so
 * the dialog can play its closing transition.
 */
export type WorkspaceDialogRequest =
	/** `onMade` opens the new workspace as the sidebar does, so it takes the place of Memory too. */
	| { kind: "new"; onMade: (slug: string) => void }
	| { kind: "instructions"; workspace: WorkspaceDetail; onSaved: (workspace: WorkspaceDetail) => void }
	| { kind: "share"; workspace: WorkspaceDetail; onSaved: (workspace: WorkspaceDetail) => void }
	| { kind: "document"; workspaceId: string; document: WorkspaceDocument; onChanged: (document: WorkspaceDocument) => void };

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

/**
 * A dialog with no field to start in (Details; Share on a phone) rests on its frame, as reka-ui
 * does when there is nothing to focus, not on ×: opened from a menu, × would wear its focus
 * ring as if chosen. Tab still reaches ×. It runs after frappe-ui's own focus on open, which
 * waits a tick and a frame too.
 */
export function useFrameFocus() {
	onMounted(() =>
		nextTick(() =>
			requestAnimationFrame(() => {
				const active = document.activeElement;
				if (active instanceof HTMLButtonElement) active.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
			}),
		),
	);
}

/** Who can use a workspace, as the dialogs offer it to an admin. */
export const KIND_OPTIONS = [
	{ label: "Only the people you add", value: "private" },
	{ label: "Everyone in the organisation", value: "org" },
];

/** The placeholders of New workspace and Instructions, in the dialogs and in their stand-in. */
export const NAME_PLACEHOLDER = "e.g. HR policies";
export const INSTRUCTIONS_PLACEHOLDER = "Additional instructions passed to the AI agent";

/** The Instructions dialog is wider than the others, for its Markdown editor: frappe-ui's Dialog size, and its width in the stand-in. */
export const INSTRUCTIONS_DIALOG_SIZE = "2xl";
export const INSTRUCTIONS_DIALOG_WIDTH = "max-w-2xl";

/** The dialog's title, in the dialog and in its stand-in. */
export function dialogTitle(request: WorkspaceDialogRequest) {
	if (request.kind === "new") return "New workspace";
	if (request.kind === "instructions") return "Instructions";
	if (request.kind === "document") return request.document.name;
	return `Share “${request.workspace.name}”`;
}
