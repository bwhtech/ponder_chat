import { describe, expect, it } from "vitest";
import type { WorkspaceDocument } from "./documents";
import { setupSteps } from "./onboarding";
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
		expect(steps.map((step) => [step.key, step.done, step.action])).toEqual([
			["instructions", false, "Add instructions"],
			["documents", false, "Upload documents"],
			["people", false, "Share workspace"],
		]);
	});

	it("a step is done once it has something: instructions, a document of any status, someone to share with", () => {
		const steps = setupSteps(workspace({ instructions: "## Cite the **leave** policy", documents: [document("a.md", "reading")], memberCount: 1 }));
		expect(steps.map((step) => step.done)).toEqual([true, true, true]);
	});

	it("instructions in a code fence are done too, and spaces alone are not", () => {
		expect(setupSteps(workspace({ instructions: "```\n```" }))[0]?.done).toBe(true);
		expect(setupSteps(workspace({ instructions: "  \n " }))[0]?.done).toBe(false);
	});

	it("an organisation workspace has no People step: everyone in the organisation uses it already", () => {
		expect(setupSteps(workspace({ kind: "org", access: "edit" })).map((step) => [step.key, step.done])).toEqual([
			["instructions", false],
			["documents", false],
		]);
	});

	it("an editor who can't share has no People step, and a person who can only ask has none", () => {
		expect(setupSteps(workspace({ access: "edit", canShare: false })).map((step) => step.key)).toEqual(["instructions", "documents"]);
		expect(setupSteps(workspace({ access: "ask", canShare: false }))).toEqual([]);
	});
});
