import { describe, expect, it } from "vitest";
import type { WorkspaceDocument } from "./documents";
import { setupSteps, starterQuestions } from "./onboarding";
import type { WorkspaceDetail } from "./store";

const owner = { id: "u1", name: "Ana", email: "ana@example.test" };

function workspace(changes: Partial<WorkspaceDetail> = {}): WorkspaceDetail {
	return {
		id: "w1",
		slug: "hr-policies",
		kind: "private",
		name: "HR Policies",
		description: "",
		icon: null,
		access: "owner",
		memberCount: 0,
		updatedAt: "2026-11-18T10:00:00.000Z",
		instructions: "",
		owner,
		canShare: true,
		createdAt: "2026-11-18T10:00:00.000Z",
		members: [],
		documents: [],
		...changes,
	};
}

function document(name: string, status: WorkspaceDocument["status"] = "ready"): WorkspaceDocument {
	return { id: name, name, mediaType: "text/markdown", size: 120, status, error: null, createdAt: "2026-11-18T10:00:00.000Z", progress: null };
}

describe("a new workspace's setup steps", () => {
	it("the owner of a new private workspace has three steps, none done", () => {
		const steps = setupSteps(workspace());
		expect(steps.map((step) => [step.key, step.done, step.action.name])).toEqual([
			["instructions", false, "Add instructions"],
			["documents", false, "Upload documents"],
			["people", false, "Share workspace"],
		]);
	});

	it("a done step says what was done: the instructions' first line, how many documents, who it is shared with", () => {
		const steps = setupSteps(workspace({ instructions: "## Cite the **leave** policy\n\nKeep it short.", documents: [document("a.md"), document("b.md", "reading")], memberCount: 1 }));
		expect(steps.map((step) => [step.done, step.detail, step.action.label])).toEqual([
			[true, "Cite the leave policy", "Edit"],
			[true, "2 documents", "Upload more"],
			[true, "Shared with 1 person", "Share"],
		]);
	});

	it("instructions in a code fence are done too, summed up by their first line inside it", () => {
		const [fenced] = setupSteps(workspace({ instructions: "```\nAnswer from the rota only.\n```" }));
		expect(fenced).toMatchObject({ done: true, detail: "Answer from the rota only.", action: { label: "Edit" } });
		const [empty] = setupSteps(workspace({ instructions: "```\n```" }));
		expect(empty).toMatchObject({ done: true, detail: "Added" });
		expect(setupSteps(workspace({ instructions: "  \n " }))[0]?.done).toBe(false);
	});

	it("an organisation workspace is shared with everyone from the start", () => {
		const [, , people] = setupSteps(workspace({ kind: "org", access: "edit" }));
		expect(people).toMatchObject({ done: true, detail: "Everyone in the organisation" });
	});

	it("an editor who can't share has no People step, and a person who can only ask has none", () => {
		expect(setupSteps(workspace({ access: "edit", canShare: false })).map((step) => step.key)).toEqual(["instructions", "documents"]);
		expect(setupSteps(workspace({ access: "ask", canShare: false }))).toEqual([]);
	});
});

describe("first questions", () => {
	it("come from the Ready documents only, oldest first, with the workspace's name last", () => {
		expect(starterQuestions("HR Policies", [document("Indexing.pdf", "reading"), document("Leave policy.md"), document("Travel.pdf"), document("Third.md")])).toEqual([
			"Summarise “Leave policy.md”",
			"What does “Travel.pdf” cover?",
			"What can I ask about in HR Policies?",
		]);
		expect(starterQuestions("HR Policies", [document("Leave policy.md")])).toEqual(["Summarise “Leave policy.md”", "What can I ask about in HR Policies?"]);
	});

	it("are none without a Ready document", () => {
		expect(starterQuestions("HR Policies", [])).toEqual([]);
		expect(starterQuestions("HR Policies", [document("a.md", "reading"), document("b.md", "failed")])).toEqual([]);
	});
});
