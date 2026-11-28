/**
 * The team rules of access.ts, as pure functions: the table of docs/teams-plan.md, "Access".
 */
import { assert, describe, it } from "@effect/vitest";
import { canAdminister, canChangePeople, canDelete, canOrganise, leavesNoAdmin, type TeamViewer } from "./access.ts";

const orgAdmin: TeamViewer = { orgAdmin: true, role: null };
const teamAdmin: TeamViewer = { orgAdmin: false, role: "admin" };
const member: TeamViewer = { orgAdmin: false, role: "member" };
const anyone: TeamViewer = { orgAdmin: false, role: null };

describe("who manages a team", () => {
	it("lets org admins and the team's admins see its members and invites, and nobody else in /admin", () => {
		assert.deepStrictEqual([orgAdmin, teamAdmin, member, anyone].map(canAdminister), [true, true, false, false]);
	});

	it("lets org admins and the team's admins change its people, but nobody while it is archived", () => {
		assert.deepStrictEqual(
			[orgAdmin, teamAdmin, member, anyone].map((viewer) => canChangePeople(viewer, false)),
			[true, true, false, false],
		);
		assert.deepStrictEqual(
			[orgAdmin, teamAdmin, member, anyone].map((viewer) => canChangePeople(viewer, true)),
			[false, false, false, false],
		);
	});

	it("lets only org admins make, rename, archive and restore a team, and delete it once archived", () => {
		assert.deepStrictEqual([orgAdmin, teamAdmin, member, anyone].map(canOrganise), [true, false, false, false]);
		assert.isTrue(canDelete(orgAdmin, true));
		assert.isFalse(canDelete(orgAdmin, false), "an active team");
		assert.isFalse(canDelete(teamAdmin, true));
	});
});

describe("the last team admin", () => {
	const team = { admins: 1 };

	it("refuses a team admin who removes or demotes the last admin, themselves too", () => {
		assert.isTrue(leavesNoAdmin(teamAdmin, team, { from: "admin", to: null }), "removed");
		assert.isTrue(leavesNoAdmin(teamAdmin, team, { from: "admin", to: "member" }), "demoted");
	});

	it("lets an org admin leave a team with no admin", () => {
		assert.isFalse(leavesNoAdmin(orgAdmin, team, { from: "admin", to: null }));
		assert.isFalse(leavesNoAdmin(orgAdmin, team, { from: "admin", to: "member" }));
	});

	it("allows a change that keeps an admin: another admin stays, a member goes, or an admin stays admin", () => {
		assert.isFalse(leavesNoAdmin(teamAdmin, { admins: 2 }, { from: "admin", to: null }));
		assert.isFalse(leavesNoAdmin(teamAdmin, team, { from: "member", to: null }));
		assert.isFalse(leavesNoAdmin(teamAdmin, team, { from: "admin", to: "admin" }));
		assert.isFalse(leavesNoAdmin(teamAdmin, team, { from: null, to: "member" }), "a new member");
	});
});
