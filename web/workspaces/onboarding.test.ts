import { describe, expect, it } from "vitest";
import type { WorkspaceDocument } from "./documents";
import { accessIcon, isShared, sharedWith } from "./access";
import { setupSteps } from "./onboarding";
import type { WorkspaceDetail } from "./store";

const owner = { id: "u1", name: "Ana", email: "ana@example.test" };

function workspace(changes: Partial<WorkspaceDetail> = {}): WorkspaceDetail {
	return {
		id: "w1",
		slug: "hr-policies",
		orgAccess: "none",
		name: "HR Policies",
		description: "",
		icon: null,
		access: "owner",
		memberCount: 0,
		teamCount: 0,
		updatedAt: "2026-11-18T10:00:00.000Z",
		instructions: "",
		owner,
		canShare: true,
		canDelete: true,
		canChangeOrgAccess: false,
		createdAt: "2026-11-18T10:00:00.000Z",
		members: [],
		teams: [],
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
			["documents", false, "Upload files"],
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

	it("People is done once the workspace is open to everyone, also with nobody added", () => {
		expect(setupSteps(workspace({ orgAccess: "ask", access: "edit" })).map((step) => [step.key, step.done])).toEqual([
			["instructions", false],
			["documents", false],
			["people", true],
		]);
	});

	it("an editor shares, so has the People step too; a person who can only ask has no steps", () => {
		expect(setupSteps(workspace({ access: "edit", canShare: true })).map((step) => step.key)).toEqual(["instructions", "documents", "people"]);
		expect(setupSteps(workspace({ access: "ask", canShare: false }))).toEqual([]);
	});
});

describe("who can use a workspace, in a word and an icon", () => {
	const summary = (orgAccess: "none" | "ask", access: string, memberCount: number, teamCount = 0) => ({ orgAccess, access, memberCount, teamCount });

	it("is open to everyone, shared, or the owner's alone", () => {
		expect(accessIcon(summary("ask", "ask", 0))).toBe("lucide-building-2");
		expect(accessIcon(summary("ask", "owner", 3))).toBe("lucide-building-2");
		expect(accessIcon(summary("none", "owner", 2))).toBe("lucide-users");
		expect(accessIcon(summary("none", "owner", 0))).toBe("lucide-lock");
		expect(sharedWith(summary("ask", "edit", 2))).toBe("Everyone");
		expect(sharedWith(summary("none", "ask", 2))).toBe("Shared with you");
		expect(sharedWith(summary("none", "owner", 1))).toBe("You and 1 person");
		expect(sharedWith(summary("none", "owner", 0))).toBe("Only you");
		expect([isShared(summary("ask", "owner", 0)), isShared(summary("none", "owner", 1)), isShared(summary("none", "owner", 0))]).toEqual([true, true, false]);
	});

	it("counts the teams added as sharing it", () => {
		expect(accessIcon(summary("none", "owner", 0, 1))).toBe("lucide-users");
		expect(sharedWith(summary("none", "owner", 0, 1))).toBe("You and 1 team");
		expect(sharedWith(summary("none", "owner", 2, 3))).toBe("You, 2 people and 3 teams");
		expect(isShared(summary("none", "owner", 0, 2))).toBe(true);
	});
});
