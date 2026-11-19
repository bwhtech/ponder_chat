import { canEdit, isShared } from "./access";
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

/** What each step says, on its setup card and on the card an empty section of the page shows (WorkspaceAbout.vue). */
const TEXT: Record<SetupStepKey, Omit<SetupStep, "key" | "done">> = {
	instructions: { title: "Instructions", description: "Tell Ponder how to answer here.", action: "Add instructions" },
	documents: { title: "Sources", description: "Add files for Ponder to answer from.", action: "Upload files" },
	people: { title: "People", description: "Choose who can ask here.", action: "Share workspace" },
};

/** One step, as its card shows it. */
export function setupStep(key: SetupStepKey, done = false): SetupStep {
	return { key, ...TEXT[key], done };
}

/**
 * The steps this person can take: Instructions and Sources for whoever can edit, and People
 * for whoever can share it (everyone who can edit, server/workspaces/access.ts). People is
 * done once someone is added, or the workspace is open to everyone.
 */
export function setupSteps(workspace: WorkspaceDetail): SetupStep[] {
	if (!canEdit(workspace)) return [];
	const steps: SetupStep[] = [
		// Any text: a code fence alone is instructions too.
		setupStep("instructions", workspace.instructions.trim() !== ""),
		setupStep("documents", workspace.documents.length > 0),
	];
	if (workspace.canShare) steps.push(setupStep("people", isShared(workspace)));
	return steps;
}
