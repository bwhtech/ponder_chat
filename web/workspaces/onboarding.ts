import { canEdit } from "./access";
import type { WorkspaceDetail } from "./store";

/**
 * The setup cards a new workspace shows its editors at the top of its page, while they have
 * no chat in it (WorkspaceOnboarding.vue). A card is a step to do; a done step's card leaves,
 * and what it added shows in the page's sections below (WorkspaceAbout.vue).
 */
export type SetupStepKey = "instructions" | "documents" | "people";
export type SetupStep = {
	key: SetupStepKey;
	title: string;
	/** What the step is for, in one line. */
	description: string;
	done: boolean;
	/** The card's button: what it does, which is also its name for screen readers. */
	action: string;
};

/**
 * The steps this person can take: Instructions and Documents for whoever can edit, and People
 * only for whoever can share (the owner; an admin on an organisation workspace). Everyone in
 * the organisation uses an organisation workspace, so its People step is done from the start.
 */
export function setupSteps(workspace: WorkspaceDetail): SetupStep[] {
	if (!canEdit(workspace)) return [];
	const steps: SetupStep[] = [
		{
			key: "instructions",
			title: "Instructions",
			description: "Tell Ponder how to answer in this workspace.",
			// Any text: a code fence alone is instructions too.
			done: workspace.instructions.trim() !== "",
			action: "Add instructions",
		},
		{
			key: "documents",
			title: "Documents",
			description: "Upload the files its answers come from.",
			done: workspace.documents.length > 0,
			action: "Upload documents",
		},
	];
	if (workspace.canShare) {
		steps.push({
			key: "people",
			title: "People",
			description: "Share it, so others can ask in it too.",
			done: workspace.kind === "org" || workspace.memberCount > 0,
			action: "Share workspace",
		});
	}
	return steps;
}
