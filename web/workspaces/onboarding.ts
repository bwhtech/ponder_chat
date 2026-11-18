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
 * for whoever can share a private workspace (its owner). Everyone in the organisation uses an
 * organisation workspace already, so it has no People step.
 */
export function setupSteps(workspace: WorkspaceDetail): SetupStep[] {
	if (!canEdit(workspace)) return [];
	const steps: SetupStep[] = [
		{
			key: "instructions",
			title: "Instructions",
			description: "Tell Ponder how to answer here.",
			// Any text: a code fence alone is instructions too.
			done: workspace.instructions.trim() !== "",
			action: "Add instructions",
		},
		{
			key: "documents",
			title: "Documents",
			description: "Add the files Ponder answers from.",
			done: workspace.documents.length > 0,
			action: "Upload documents",
		},
	];
	if (workspace.canShare && workspace.kind !== "org") {
		steps.push({
			key: "people",
			title: "People",
			description: "Choose who can ask here.",
			done: workspace.memberCount > 0,
			action: "Share workspace",
		});
	}
	return steps;
}
