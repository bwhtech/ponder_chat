import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { useSharing, type SharingApi } from "./sharing";
import type { Member, MemberAccess, OrgAccess, WorkspaceDetail } from "./store";

const owner = { id: "ana", name: "Ana", email: "ana@example.test" };
const bea = { id: "bea", name: "Bea", email: "bea@example.test" };
const cal = { id: "cal", name: "Cal", email: "cal@example.test" };

function detail(members: Member[], orgAccess: OrgAccess = "none", changes: Partial<WorkspaceDetail> = {}): WorkspaceDetail {
	return {
		id: "w1",
		slug: "hr",
		orgAccess,
		name: "HR",
		description: "",
		icon: null,
		access: "owner",
		memberCount: members.length,
		createdAt: "2026-11-18T10:00:00.000000Z",
		updatedAt: "2026-11-18T10:00:00.000Z",
		instructions: "",
		owner,
		canShare: true,
		canDelete: true,
		canChangeOrgAccess: true,
		members,
		documents: [],
		...changes,
	};
}

/**
 * A server the test answers by hand: each request waits until the test settles it, so the
 * test chooses the order. `members` and `orgAccess` are what it has saved.
 */
function fakeServer(start: WorkspaceDetail) {
	let members = [...(start.members ?? [])];
	let orgAccess = start.orgAccess;
	const sent: string[] = [];
	const waiting: { answer: () => void; refuse: (error: Error) => void }[] = [];
	const request = (line: string, change: () => void) =>
		new Promise<WorkspaceDetail>((resolve, reject) => {
			sent.push(line);
			waiting.push({
				answer: () => {
					change();
					resolve(detail(members, orgAccess));
				},
				refuse: reject,
			});
		});
	const person = (id: string) => [bea, cal].find((each) => each.id === id)!;
	const api: SharingApi = {
		setMember: (userId: string, access: MemberAccess) =>
			request(`PUT ${userId} ${access}`, () => {
				members = [...members.filter((member) => member.id !== userId), { ...person(userId), access }];
			}),
		removeMember: (userId: string) => request(`DELETE ${userId}`, () => (members = members.filter((member) => member.id !== userId))),
		setOrgAccess: (value: OrgAccess) => request(`ACCESS ${value}`, () => (orgAccess = value)),
	};
	/** Settles the oldest request still waiting, then lets the next one go out. */
	const next = async (refusal?: Error) => {
		const first = waiting.shift();
		if (!first) throw new Error("No request is waiting.");
		if (refusal) first.refuse(refusal);
		else first.answer();
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	return { api, sent, next, saved: () => members.map((member) => `${member.id}:${member.access}`) };
}

function setup(start = detail([])) {
	const server = fakeServer(start);
	const said: string[] = [];
	const answers: WorkspaceDetail[] = [];
	const ended: string[] = [];
	const sharing = useSharing(start, server.api, {
		saved: (workspace) => answers.push(workspace),
		lost: () => ended.push("lost"),
		gone: () => ended.push("gone"),
		failed: (message) => said.push(message),
	});
	const shown = () => sharing.members.value.map((member) => `${member.id}:${member.access}`);
	return { sharing, server, said, answers, ended, shown };
}

describe("Share applies each change at once", () => {
	it("shows a person at once, sends one request at a time, and the answers keep the rows where they are", async () => {
		const { sharing, server, answers, shown } = setup();
		sharing.add(bea, "edit");
		sharing.add(cal, "ask");
		expect(shown()).toEqual(["bea:edit", "cal:ask"]);
		expect(server.sent).toEqual(["PUT bea edit"]);
		await server.next();
		expect(server.sent).toEqual(["PUT bea edit", "PUT cal ask"]);
		await server.next();
		expect(server.saved()).toEqual(["bea:edit", "cal:ask"]);
		expect(shown()).toEqual(["bea:edit", "cal:ask"]);
		expect(answers.map((answer) => answer.memberCount)).toEqual([1, 2]);
	});

	it("sends only the last choice for a person whose change is still on its way, so the server ends as the dialog shows", async () => {
		const { sharing, server, shown } = setup(detail([{ ...bea, access: "ask" }]));
		sharing.setRole("bea", "edit");
		sharing.setRole("bea", "ask");
		sharing.setRole("bea", "edit");
		sharing.remove("bea");
		expect(shown()).toEqual([]);
		await server.next();
		await server.next();
		expect(server.sent).toEqual(["PUT bea edit", "DELETE bea"]);
		expect(server.saved()).toEqual([]);
		expect(shown()).toEqual([]);
	});

	it("takes a refused change back, and says why", async () => {
		const { sharing, server, said, shown } = setup(detail([{ ...bea, access: "ask" }]));
		sharing.setRole("bea", "edit");
		expect(shown()).toEqual(["bea:edit"]);
		await server.next(new ApiError("Only the owner and people who can edit can share this workspace.", 403));
		expect(shown()).toEqual(["bea:ask"]);
		expect(said).toEqual(["Bea's role could not be changed. Only the owner and people who can edit can share this workspace."]);
		sharing.add(cal, "ask");
		await server.next(new ApiError("Something went wrong (500).", 500));
		expect(shown()).toEqual(["bea:ask"]);
		expect(said.at(-1)).toBe("Cal could not be added. Try again.");
	});

	it("does not take back a refused change the person has changed since: the newer one goes next", async () => {
		const { sharing, server, said, shown } = setup(detail([{ ...bea, access: "ask" }]));
		sharing.setRole("bea", "edit");
		sharing.remove("bea");
		await server.next(new ApiError("Down", 500));
		expect(said).toEqual([]);
		expect(shown()).toEqual([]);
		expect(server.sent).toEqual(["PUT bea edit", "DELETE bea"]);
		await server.next();
		expect(server.saved()).toEqual([]);
	});

	it("changes General access at once, and puts it back when refused", async () => {
		const { sharing, server, said } = setup();
		sharing.setGeneral("ask");
		expect(sharing.orgAccess.value).toBe("ask");
		await server.next(new ApiError("Only an admin can open a workspace to everyone, or close it.", 403));
		expect(sharing.orgAccess.value).toBe("none");
		expect(said).toEqual(["General access could not be changed. Only an admin can open a workspace to everyone, or close it."]);
		sharing.setGeneral("ask");
		await server.next();
		expect(sharing.orgAccess.value).toBe("ask");
	});

	it("stops once the person can no longer share, or the workspace is gone for them", async () => {
		const lost = setup(detail([{ ...bea, access: "ask" }]));
		lost.server.api.removeMember = () => Promise.resolve(detail([], "none", { access: "none", canShare: false, members: null }));
		// Bea, an editor, removes herself; Cal, added just after, is never sent.
		lost.sharing.remove("bea");
		lost.sharing.add(cal, "ask");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(lost.ended).toEqual(["lost"]);
		// Nothing more is sent.
		expect(lost.server.sent).toEqual([]);

		const gone = setup();
		gone.sharing.add(bea, "ask");
		await gone.server.next(new ApiError("Not found", 404));
		expect(gone.ended).toEqual(["gone"]);
		expect(gone.said).toEqual([]);
	});
});
