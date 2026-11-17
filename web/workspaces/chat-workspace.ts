import { computed, defineAsyncComponent, ref, watch } from "vue";
import { once } from "../once";
import { takeFirstMessage } from "./first-message";
import { loadWorkspaces, workspaceById, workspaces, workspacesLoaded } from "./store";
import WorkspaceChip from "./WorkspaceChip.vue";

export { WorkspaceChip };

/**
 * The workspace menu of a new chat's composer, as its own chunk: it brings frappe-ui's
 * Dropdown, which the first page does not need. Its button stands in until it is here.
 */
const loadPicker = once(() => import("./WorkspacePicker.vue").then((module) => module.default));
export const WorkspacePicker = defineAsyncComponent({ loader: loadPicker, loadingComponent: WorkspaceChip, delay: 0 });

/**
 * A chat's workspace (ChatView.vue). A saved chat keeps the one its first message set
 * (`saved`); a new chat picks one in the composer, or comes with one from a workspace page
 * (first-message.ts). After the first message it never changes.
 *
 * A person removed from the chat's workspace no longer has it in their list: the chat can
 * still be read, but the composer is closed, as the server would refuse the message.
 */
export function useChatWorkspace(threadId: string, saved: () => string | undefined, started: () => boolean) {
	const firstMessage = takeFirstMessage(threadId);
	const chosen = ref<string | null>(saved() ?? firstMessage?.workspaceId ?? null);
	watch(saved, (id) => id && (chosen.value = id));

	const locked = computed(() => Boolean(saved()) || started());
	return {
		firstMessage,
		chosen,
		locked,
		summary: computed(() => workspaceById(chosen.value)),
		pickable: computed(() => !locked.value && workspaces.value.length > 0),
		lostAccess: computed(() => {
			const id = saved();
			return Boolean(id) && workspacesLoaded.value && !workspaceById(id);
		}),
		/** A send was refused: ask for the list again, in case the person lost the workspace. */
		recheck: () => void (chosen.value && loadWorkspaces()),
	};
}
