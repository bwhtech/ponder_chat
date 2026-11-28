import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { useSharing, type SharingApi } from "./sharing";
import type { Member, MemberAccess, OrgAccess, WorkspaceDetail, WorkspaceTeam } from "./store";

const owner = { id: "ana", name: "Ana", email: "ana@example.test" };
const bea = { id: "bea", name: "Bea", email: "bea@example.test" };
const cal = { id: "cal", name: "Cal", email: "cal@example.test" };
const hr = { id: "hr", name: "HR", memberCount: 12 };
const ops = { id: "ops", name: "Ops", memberCount: 3 };
let workspaces = 0;

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
		teamCount: 0,
		createdAt: "2026-11-18T10:00:00.000000Z",
		updatedAt: "2026-11-18T10:00:00.000Z",
		instructions: "",
		owner,
		canShare: true,
		canDelete: true,
		canChangeOrgAccess: true,
		members,
		teams: [],
		documents: [],
		...changes,
	};
}

/**
 * A server the test answers by hand: each request waits until the test settles it, so the
 * test chooses the order. `members` and `orgAccess` are what it has saved; `refresh.answer` is
 * what GET /api/workspaces/:id answers.
 */
function fakeServer(start: WorkspaceDetail) {
	let members = [...(start.members ?? [])];
	let orgAccess = start.orgAccess;
	let teams: WorkspaceTeam[] = [...(start.teams ?? [])];
	const sent: string[] = [];
	const waiting: { answer: (answer?: WorkspaceDetail) => void; refuse: (error: Error) => void }[] = [];
	const now = () => ({ ...start, ...detail(members, orgAccess), teams, id: start.id });
	const request = (line: string, change: () => void) =>
		new Promise<WorkspaceDetail>((resolve, reject) => {
			sent.push(line);
			waiting.push({
				answer: (answer) => {
					change();
					resolve(answer ?? now());
				},
				refuse: reject,
			});
		});
	const person = (id: string) => [bea, cal].find((each) => each.id === id)!;
	const refresh = { answer: (): Promise<WorkspaceDetail> => Promise.resolve(now()) };
	return {
		sent,
		refresh,
		api: {
			setMember: (userId: string, access: MemberAccess) =>
				request(`PUT ${userId} ${access}`, () => {
					members = [...members.filter((member) => member.id !== userId), { ...person(userId), access }];
				}),
			removeMember: (userId: string) => request(`DELETE ${userId}`, () => (members = members.filter((member) => member.id !== userId))),
			setOrgAccess: (value: OrgAccess) => request(`ACCESS ${value}`, () => (orgAccess = value)),
			setTeam: (teamId: string, access: MemberAccess) =>
				request(`TEAM ${teamId} ${access}`, () => {
					const team = [hr, ops].find((each) => each.id === teamId)!;
					teams = [...teams.filter((each) => each.id !== teamId), { ...team, access, archived: false }];
				}),
			removeTeam: (teamId: string) => request(`TEAM ${teamId} removed`, () => (teams = teams.filter((each) => each.id !== teamId))),
			refresh: () => refresh.answer(),
		} satisfies SharingApi,
		/** Settles the oldest request still waiting, then lets the next one go out. */
		next: async (refusal?: Error) => {
			const first = waiting.shift();
			if (!first) throw new Error("No request is waiting.");
			if (refusal) first.refuse(refusal);
			else first.answer();
			await settle();
		},
		/** Answers the oldest request with this workspace: what the server had once the change was in, and others' changes after it. */
		answerWith: async (answer: WorkspaceDetail) => {
			const first = waiting.shift();
			if (!first) throw new Error("No request is waiting.");
			first.answer({ ...answer, id: start.id });
			await settle();
		},
		saved: () => members.map((member) => `${member.id}:${member.access}`),
		savedTeams: () => teams.map((team) => `${team.id}:${team.access}`),
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A dialog on the workspace: its events, and what it shows. */
function openShare(start: WorkspaceDetail, server: ReturnType<typeof fakeServer>, me = "ana") {
	const said: string[] = [];
	const answers: WorkspaceDetail[] = [];
	const ended: string[] = [];
	const sharing = useSharing(
		start,
		server.api,
		{
			saved: (workspace) => answers.push(workspace),
			lost: (_, why) => ended.push(`lost:${why}`),
			gone: () => ended.push("gone"),
			failed: (message) => said.push(message),
		},
		me,
	);
	const shown = () => sharing.members.value.map((member) => `${member.id}:${member.access}`);
	const shownTeams = () => sharing.teams.value.map((team) => `${team.id}:${team.access}${team.archived ? ":archived" : ""}`);
	return { sharing, said, answers, ended, shown, shownTeams };
}

/** A workspace of the test's own (the queues are kept by workspace), its server, and Share open on it. */
function setup(start = detail([]), me = "ana") {
	const workspace = { ...start, id: `w${++workspaces}` };
	const server = fakeServer(workspace);
	return { ...openShare(workspace, server, me), server, workspace };
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
		await server.next(new ApiError("The owner always has full access.", 403));
		expect(shown()).toEqual(["bea:ask"]);
		expect(said).toEqual(["Bea's role could not be changed. The owner always has full access."]);
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

	it("shows the server's state once it answers a choice, even when someone changed it meanwhile", async () => {
		const { sharing, server, shown } = setup(detail([{ ...bea, access: "ask" }]));
		sharing.setRole("bea", "edit");
		// Another editor set Bea back to Can ask before this answer was read.
		await server.answerWith(detail([{ ...bea, access: "ask" }]));
		expect(shown()).toEqual(["bea:ask"]);
		expect(server.sent).toEqual(["PUT bea edit"]);

		sharing.setGeneral("ask");
		await server.answerWith(detail([{ ...bea, access: "ask" }], "none"));
		expect(sharing.orgAccess.value).toBe("none");

		// A choice made after the request went stays, and is sent next.
		sharing.setRole("bea", "edit");
		sharing.setRole("bea", "ask");
		sharing.setRole("bea", "edit");
		await server.answerWith(detail([{ ...bea, access: "ask" }]));
		expect(shown()).toEqual(["bea:edit"]);
		expect(server.sent.slice(-1)).toEqual(["PUT bea edit"]);
	});

	it("keeps one queue for the workspace when Share is opened again while a change is on its way, and the closed dialog hears nothing more", async () => {
		const first = setup(detail([{ ...bea, access: "ask" }]));
		first.sharing.setRole("bea", "edit");
		expect(first.server.sent).toEqual(["PUT bea edit"]);
		// Done, then Share again: Bea is removed while the grant is still on its way.
		const again = openShare(first.workspace, first.server);
		expect(again.shown()).toEqual(["bea:edit"]);
		again.sharing.remove("bea");
		expect(first.server.sent, "the removal waits for the grant").toEqual(["PUT bea edit"]);
		await first.server.next();
		expect(first.server.sent).toEqual(["PUT bea edit", "DELETE bea"]);
		await first.server.next();
		expect(first.server.saved()).toEqual([]);
		expect(again.shown()).toEqual([]);
		expect(first.answers).toEqual([]);
		expect(again.answers).toHaveLength(2);
	});

	it("keeps one queue for the workspace after a quiet spell: Share opened again during a later change still joins it", async () => {
		const first = setup();
		first.sharing.add(bea, "ask");
		await first.server.next();
		// Nothing on its way now. Then Bea is given Can edit, and Share is opened again while that waits.
		first.sharing.setRole("bea", "edit");
		const again = openShare(first.workspace, first.server);
		expect(again.shown()).toEqual(["bea:edit"]);
		again.sharing.remove("bea");
		expect(first.server.sent, "the removal waits for the grant").toEqual(["PUT bea ask", "PUT bea edit"]);
		await first.server.next();
		await first.server.next();
		expect(first.server.sent).toEqual(["PUT bea ask", "PUT bea edit", "DELETE bea"]);
		expect(first.server.saved()).toEqual([]);
		expect(again.shown()).toEqual([]);
	});

	it("ends Share on a 404, even when a newer choice for the row waits", async () => {
		const { sharing, server, said, ended } = setup(detail([{ ...bea, access: "ask" }]));
		sharing.setRole("bea", "edit");
		sharing.setRole("bea", "ask");
		sharing.add(cal, "ask");
		await server.next(new ApiError("Not found", 404));
		expect(ended).toEqual(["gone"]);
		expect(said).toEqual([]);
		expect(server.sent).toEqual(["PUT bea edit"]);
	});

	it("asks again after a 403: a person who can no longer share sees Share end, and nothing more is sent", async () => {
		const demoted = setup(detail([{ ...bea, access: "edit" }, { ...cal, access: "ask" }], "none", { access: "edit" }), "bea");
		demoted.server.refresh.answer = () => Promise.resolve(detail([], "none", { id: demoted.workspace.id, access: "ask", canShare: false, members: null }));
		demoted.sharing.setRole("cal", "edit");
		demoted.sharing.add(cal, "edit");
		await demoted.server.next(new ApiError("Only the owner and people who can edit can share this workspace.", 403));
		await settle();
		expect(demoted.ended).toEqual(["lost:changed"]);
		expect(demoted.said).toEqual([]);
		demoted.sharing.setRole("cal", "ask");
		expect(demoted.server.sent).toEqual(["PUT cal edit"]);

		// A 403 for something else is said in the dialog, and Share stays.
		const refused = setup(detail([{ ...bea, access: "ask" }]));
		refused.sharing.setGeneral("ask");
		await refused.server.next(new ApiError("Only an admin can open a workspace to everyone, or close it.", 403));
		await settle();
		expect(refused.ended).toEqual([]);
		expect(refused.said).toEqual(["General access could not be changed. Only an admin can open a workspace to everyone, or close it."]);
	});

	it("ends once the person removes themselves, or the workspace is gone for them", async () => {
		const lost = setup(detail([{ ...bea, access: "edit" }], "none", { access: "edit" }), "bea");
		lost.server.api.removeMember = () => Promise.resolve(detail([], "none", { id: lost.workspace.id, access: "none", canShare: false, members: null }));
		// Bea, an editor, removes herself; Cal, added just after, is never sent.
		lost.sharing.remove("bea");
		lost.sharing.add(cal, "ask");
		await settle();
		expect(lost.ended).toEqual(["lost:self"]);
		expect(lost.server.sent).toEqual([]);

		const gone = setup();
		gone.sharing.add(bea, "ask");
		await gone.server.next(new ApiError("Not found", 404));
		expect(gone.ended).toEqual(["gone"]);
		expect(gone.said).toEqual([]);
	});
});

describe("Share applies each change to a team at once", () => {
	it("shows a team at once, in the order added, in the same queue as people", async () => {
		const { sharing, server, shownTeams, shown } = setup();
		sharing.addTeam(hr, "ask");
		sharing.add(bea, "ask");
		sharing.addTeam(ops, "edit");
		expect(shownTeams()).toEqual(["hr:ask", "ops:edit"]);
		expect(shown()).toEqual(["bea:ask"]);
		await server.next();
		await server.next();
		await server.next();
		expect(server.sent).toEqual(["TEAM hr ask", "PUT bea ask", "TEAM ops edit"]);
		expect(server.savedTeams()).toEqual(["hr:ask", "ops:edit"]);
		expect(shownTeams()).toEqual(["hr:ask", "ops:edit"]);
	});

	it("changes a team's role and removes it, sending only the last choice", async () => {
		const { sharing, server, shownTeams } = setup(detail([], "none", { teams: [{ ...hr, access: "ask", archived: false }] }));
		sharing.setTeamRole("hr", "edit");
		sharing.setTeamRole("hr", "ask");
		sharing.removeTeam("hr");
		expect(shownTeams()).toEqual([]);
		await server.next();
		await server.next();
		expect(server.sent).toEqual(["TEAM hr edit", "TEAM hr removed"]);
		expect(server.savedTeams()).toEqual([]);
	});

	it("takes a refused team change back and names the team; an archived grant stays as it is", async () => {
		const archived = { ...ops, access: "ask" as const, archived: true };
		const { sharing, server, said, shownTeams } = setup(detail([], "none", { teams: [archived] }));
		expect(shownTeams()).toEqual(["ops:ask:archived"]);
		sharing.addTeam(hr, "ask");
		await server.next(new ApiError("This team is archived, so it can't be added.", 403));
		expect(shownTeams()).toEqual(["ops:ask:archived"]);
		expect(said).toEqual(["HR could not be added. This team is archived, so it can't be added."]);
		sharing.removeTeam("ops");
		await server.next(new ApiError("Down", 500));
		expect(said.at(-1)).toBe("Ops could not be removed. Try again.");
		expect(shownTeams()).toEqual(["ops:ask:archived"]);
	});
});
