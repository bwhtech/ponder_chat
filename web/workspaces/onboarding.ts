import { count } from "../numbers";
import type { WorkspaceDocument } from "./documents";
import { canEdit, people } from "./access";
import type { WorkspaceDetail } from "./store";

/**
 * What a workspace page shows in place of "Your chats" while the person has no chat in it
 * (WorkspaceOnboarding.vue). A person who can edit gets the setup steps until each one is
 * done; then, and for a person who can only ask, a few first questions made from what the
 * workspace has. No model is asked: the questions come from the names of its Ready documents.
 */
export type SetupStepKey = "instructions" | "documents" | "people";
export type SetupStep = {
	key: SetupStepKey;
	title: string;
	/** What the step is for, while it is not done; once it is, what was done ("2 documents"). */
	detail: string;
	done: boolean;
	/** The row's button: its name for screen readers, and the short word shown at its end. */
	action: { name: string; label: string };
};

/**
 * The steps this person can take: Instructions and Documents for whoever can edit, and People
 * only for whoever can share (the owner; an admin on an organisation workspace). Everyone in
 * the organisation uses an organisation workspace, so its People step is done from the start.
 */
export function setupSteps(workspace: WorkspaceDetail): SetupStep[] {
	if (!canEdit(workspace)) return [];
	// Done when there is any text. The first line is only the summary: it can be empty, as for a code fence.
	const hasInstructions = workspace.instructions.trim() !== "";
	const instructions = firstLine(workspace.instructions) || (hasInstructions ? "Added" : "");
	const documents = workspace.documents.length;
	const shared = workspace.kind === "org" || workspace.memberCount > 0;
	const steps: SetupStep[] = [
		{
			key: "instructions",
			title: "Instructions",
			detail: instructions || "How Ponder answers here",
			done: hasInstructions,
			action: hasInstructions ?{ name: "Edit instructions", label: "Edit" } : { name: "Add instructions", label: "Add" },
		},
		{
			key: "documents",
			title: "Documents",
			detail: documents ? `${count(documents)} ${documents === 1 ? "document" : "documents"}` : "Files answers come from",
			done: documents > 0,
			action: documents ? { name: "Upload more documents", label: "Upload more" } : { name: "Upload documents", label: "Upload" },
		},
	];
	if (workspace.canShare) {
		steps.push({
			key: "people",
			title: "People",
			detail: workspace.kind === "org" ? "Everyone in the organisation" : shared ? `Shared with ${people(workspace.memberCount)}` : "Who can ask in this workspace",
			done: shared,
			action: { name: "Share workspace", label: "Share" },
		});
	}
	return steps;
}

/**
 * Up to three questions to start with, from the workspace's Ready documents, oldest first: a
 * document still Indexing can't answer yet. None without a Ready document.
 */
export function starterQuestions(workspaceName: string, documents: readonly WorkspaceDocument[]) {
	const ready = documents.filter((document) => document.status === "ready");
	const [first, second] = ready;
	if (!first) return [];
	return [`Summarise “${first.name}”`, ...(second ? [`What does “${second.name}” cover?`] : []), `What can I ask about in ${workspaceName}?`];
}

/** The instructions' first line of text, without its Markdown marks: the done step's summary. */
function firstLine(instructions: string) {
	// A code fence's own line ("```", "```python") says nothing: the text under it does.
	const line = instructions.split("\n").find((text) => text.trim() && !/^\s*(```|~~~)/.test(text)) ?? "";
	return line
		.replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
		.replace(/(\*\*|__|`|~~)/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim();
}
