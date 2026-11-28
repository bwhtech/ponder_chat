/**
 * Teams through their HTTP routes (routes.ts, under /api/admin), on a real Postgres
 * (TEST_DATABASE_URL), in a schema of their own that the last step drops: who makes and
 * changes a team, who is in it with which role, the last-admin rule, and the activity log.
 * The app and the people are in test-app.ts.
 */
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { base, call, create, database, type List, type One, type Refusal, removeMember, roles, setMember, setUp, tag, tearDown, who } from "./test-app.ts";

describe.skipIf(!base)("teams through their routes", () => {
	beforeAll(setUp);
	afterAll(tearDown);

	it("lets an org admin make a team with its first team admin, and lists it", async () => {
		const made = await create("boss", "  Human resources ", "ana", "People and pay");
		assert.strictEqual(made.status, 201, JSON.stringify(made.body));
		assert.deepInclude(made.body.team, { name: "Human resources", description: "People and pay", archived: false });
		assert.deepStrictEqual(roles(made.body.team), [[who.ana, "admin"]]);
		assert.deepStrictEqual(made.body.team.invites, []);

		const list = await call<List>("boss", "GET", "/api/admin/teams");
		assert.strictEqual(list.status, 200);
		assert.deepInclude(list.body.teams.find((team) => team.id === made.body.team.id), {
			name: "Human resources",
			memberCount: 1,
			adminCount: 1,
			inviteCount: 0,
			archived: false,
		});
	});

	it("refuses a name another team has in any case, a banned or unknown first admin, and a bad name", async () => {
		assert.strictEqual((await create("boss", "Finance", "bob")).status, 201);
		const taken = await create("boss2", "FINANCE", "cy");
		assert.deepStrictEqual([taken.status, taken.body.error], [409, "A team with this name already exists."]);
		const banned = await create("boss", "Banned lead", "eve");
		assert.deepStrictEqual([banned.status, banned.body.error], [403, "This person is banned, so they can't join a team."]);
		const unknown = await call<Refusal>("boss", "POST", "/api/admin/teams", { name: "Ghosts", adminUserId: "nobody" });
		assert.deepStrictEqual([unknown.status, unknown.body.error], [400, "That person has no account."]);
		assert.strictEqual((await create("boss", "   ", "cy")).status, 400, "empty after trim");
		assert.strictEqual((await create("boss", "x".repeat(81), "cy")).status, 400);
		assert.strictEqual((await create("boss", "x".repeat(80), "cy")).status, 201);
		const names = (await call<List>("boss", "GET", "/api/admin/teams")).body.teams.map((team) => team.name);
		assert.notInclude(names, "Banned lead");
		assert.notInclude(names, "Ghosts");
	});

	it("answers 403 on every team route to people who admin no team: a member, and someone in no team", async () => {
		const team = (await create("boss", "Guarded", "ana")).body.team.id;
		await setMember("boss", team, "fay", "member");
		const routes: [string, string, unknown?][] = [
			["GET", "/api/admin/teams"],
			["POST", "/api/admin/teams", { name: "Mine", adminUserId: who.fay }],
			["GET", `/api/admin/teams/${team}`],
			["PATCH", `/api/admin/teams/${team}`, { name: "Renamed" }],
			["PUT", `/api/admin/teams/${team}/members/${who.gus}`, { role: "member" }],
			["DELETE", `/api/admin/teams/${team}/members/${who.ana}`],
			["POST", `/api/admin/teams/${team}/invites`, { email: "new@example.invalid", role: "member" }],
			["DELETE", `/api/admin/teams/${team}/invites/new@example.invalid`],
		];
		for (const person of ["fay", "gus"] as const) {
			for (const [method, path, json] of routes) assert.strictEqual((await call(person, method, path, json)).status, 403, `${person} ${method} ${path}`);
		}
		assert.deepStrictEqual(roles((await call<One>("boss", "GET", `/api/admin/teams/${team}`)).body.team), [
			[who.ana, "admin"],
			[who.fay, "member"],
		], "nothing changed");
	});

	it("lets an org admin add people with a role, change roles and remove people, never a banned person", async () => {
		const team = (await create("boss", "Support", "ana")).body.team.id;
		assert.strictEqual((await setMember("boss", team, "bob", "member")).status, 200);
		const added = await setMember("boss2", team, "cy", "admin");
		assert.strictEqual(added.status, 200);
		assert.deepStrictEqual(roles(added.body.team), [
			[who.ana, "admin"],
			[who.bob, "member"],
			[who.cy, "admin"],
		]);
		assert.deepInclude(added.body.team, { canOrganise: true, canChangePeople: true });

		assert.deepStrictEqual(roles((await setMember("boss", team, "bob", "admin")).body.team)[1], [who.bob, "admin"]);
		assert.deepStrictEqual(roles((await removeMember("boss", team, "cy")).body.team), [
			[who.ana, "admin"],
			[who.bob, "admin"],
		]);
		assert.strictEqual((await removeMember("boss", team, "dan")).status, 200, "not a member: no change");

		const banned = await setMember("boss", team, "eve", "member");
		assert.deepStrictEqual([banned.status, banned.body.error], [403, "This person is banned, so they can't join a team."]);
		assert.strictEqual((await setMember("boss", team, "nobody", "member")).status, 400);
		assert.strictEqual((await setMember("boss", team, "dan", "owner")).status, 400, "no such role");
		assert.strictEqual((await setMember("boss", "no-such-team", "dan", "member")).status, 404);

		const list = (await call<List>("boss", "GET", "/api/admin/teams")).body.teams.find((each) => each.id === team);
		assert.deepInclude(list, { memberCount: 2, adminCount: 2 });
	});

	it("lets an org admin remove or demote the last team admin, which leaves the team to org admins", async () => {
		const team = (await create("boss", "Orphans", "ana")).body.team.id;
		assert.strictEqual((await setMember("boss", team, "ana", "member")).status, 200);
		const list = (await call<List>("boss", "GET", "/api/admin/teams")).body.teams.find((each) => each.id === team);
		assert.deepInclude(list, { memberCount: 1, adminCount: 0 });
		assert.deepStrictEqual(roles((await removeMember("boss", team, "ana")).body.team), []);
	});

	it("logs every change to a team in the admin activity log, with the person it was done to", async () => {
		const team = (await create("boss", "Logged", "ana", "First")).body.team.id;
		await call("boss", "PATCH", `/api/admin/teams/${team}`, { name: "Logged team", description: "Second" });
		await call("boss", "PATCH", `/api/admin/teams/${team}`, { name: "Logged team" });
		await setMember("boss", team, "bob", "member");
		await setMember("boss", team, "bob", "member");
		await setMember("boss", team, "bob", "admin");
		await removeMember("boss", team, "bob");
		const logged = await database(
			(sql) => sql<{ action: string; target: string | null; before: unknown; after: unknown }>`
				select action, target, before, after from admin_events where coalesce(after, before)->>'team' = ${team} order by id`,
		);
		assert.deepStrictEqual(
			logged.map((event) => [event.action, event.target]),
			[
				["create-team", who.ana],
				["update-team", null],
				["add-team-member", who.bob],
				["set-team-role", who.bob],
				["remove-team-member", who.bob],
			],
			"one event for each change, none for a change to the same value",
		);
		assert.deepStrictEqual(logged[1].before, { team, name: "Logged", description: "First" });
		assert.deepStrictEqual(logged[1].after, { team, name: "Logged team", description: "Second" });
		assert.deepStrictEqual(logged[3].after, { team, name: "Logged team", role: "admin" });
	});

	it("refuses a rename to another team's name", async () => {
		const team = (await create("boss", "Legal", "ana")).body.team.id;
		await create("boss", "Compliance", "ana");
		const taken = await call<Refusal>("boss", "PATCH", `/api/admin/teams/${team}`, { name: "compliance" });
		assert.strictEqual(taken.status, 409);
		const renamed = await call<One>("boss", "PATCH", `/api/admin/teams/${team}`, { name: "LEGAL" });
		assert.deepInclude(renamed.body.team, { name: "LEGAL" }, "its own name, in another case");
	});
	describe("a team admin", () => {
		const outcome = (answer: { status: number; body: Refusal }) => (answer.status === 200 ? "ok" : `${answer.status} ${answer.body.error}`);
		const LAST_ADMIN = "403 A team needs at least one team admin. Make someone else a team admin first.";
		const NEEDS_TEAM_ADMIN = "403 Only this team's admins and org admins can do this.";
		const NEEDS_ORG_ADMIN = "403 Only org admins can do this.";

		it("manages the people of their own team, but never leaves it without a team admin", async () => {
			const team = (await create("boss", `Ops ${tag}`, "ana")).body.team.id;
			assert.strictEqual(outcome(await setMember("ana", team, "bob", "member")), "ok");
			assert.strictEqual(outcome(await setMember("ana", team, "ana", "member")), LAST_ADMIN, "demotes themselves");
			assert.strictEqual(outcome(await removeMember("ana", team, "ana")), LAST_ADMIN, "removes themselves");
			assert.strictEqual(outcome(await setMember("ana", team, "bob", "admin")), "ok");
			assert.strictEqual(outcome(await removeMember("ana", team, "ana")), "ok", "another admin stays");
			assert.strictEqual(outcome(await removeMember("bob", team, "bob")), LAST_ADMIN);
			const detail = await call<One>("bob", "GET", `/api/admin/teams/${team}`);
			assert.deepInclude(detail.body.team, { canOrganise: false, canChangePeople: true });
		});

		it("answers null, not the team, to a team admin who demoted or removed themselves", async () => {
			const team = (await create("boss", `Self ${tag}`, "ana")).body.team.id;
			await setMember("ana", team, "bob", "admin");
			assert.isNull((await setMember("ana", team, "ana", "member")).body.team, "demoted: no members or invites");
			await setMember("bob", team, "ana", "admin");
			assert.isNull((await removeMember("ana", team, "ana")).body.team, "removed");
			assert.isNotNull((await removeMember("bob", team, "cy")).body.team, "removing someone else answers the team");
		});

		it("keeps one team admin when the last two leave or step down at the same time", async () => {
			const pair = async (name: string) => {
				const team = (await create("boss", `${name} ${tag}`, "ana")).body.team.id;
				await setMember("ana", team, "bob", "admin");
				return team;
			};
			const admins = async (team: string) => (await call<One>("boss", "GET", `/api/admin/teams/${team}`)).body.team.members.filter((member) => member.role === "admin").length;

			const both = await pair("Race");
			const removed = await Promise.all([removeMember("ana", both, "ana"), removeMember("bob", both, "bob")]);
			assert.sameMembers(removed.map(outcome), ["ok", LAST_ADMIN]);
			assert.strictEqual(await admins(both), 1);

			const mixed = await pair("Race mixed");
			const changed = await Promise.all([removeMember("ana", mixed, "ana"), setMember("bob", mixed, "bob", "member")]);
			assert.sameMembers(changed.map(outcome), ["ok", LAST_ADMIN]);
			assert.strictEqual(await admins(mixed), 1);
		});

		it("refuses members, other teams' admins and the org-admin actions", async () => {
			const team = (await create("boss", `Desk ${tag}`, "ana")).body.team.id;
			await setMember("ana", team, "bob", "member");
			const other = (await create("boss", `Other ${tag}`, "cy")).body.team.id;
			assert.strictEqual(outcome(await setMember("bob", team, "dan", "member")), NEEDS_TEAM_ADMIN, "a member");
			assert.strictEqual(outcome(await call<Refusal>("bob", "GET", `/api/admin/teams/${team}`)), NEEDS_TEAM_ADMIN, "a member in /admin");
			assert.strictEqual(outcome(await setMember("cy", team, "dan", "member")), NEEDS_TEAM_ADMIN, "another team's admin");
			assert.strictEqual(outcome(await removeMember("cy", team, "ana")), NEEDS_TEAM_ADMIN, "another team's admin");
			assert.strictEqual(outcome(await call<Refusal>("ana", "GET", `/api/admin/teams/${other}`)), NEEDS_TEAM_ADMIN);
			assert.strictEqual(outcome(await call<Refusal>("ana", "PATCH", `/api/admin/teams/${team}`, { name: "Mine now" })), NEEDS_ORG_ADMIN);
			assert.strictEqual(outcome(await create("ana", "Another", "ana")), NEEDS_ORG_ADMIN);
			const listed = (await call<List>("ana", "GET", "/api/admin/teams")).body.teams.map((each) => each.id);
			assert.include(listed, team);
			assert.notInclude(listed, other, "only the teams they admin");
		});

		it("changes nothing in an archived team, and no longer sees it", async () => {
			const team = (await create("boss", `Shelf ${tag}`, "ana")).body.team.id;
			await database((sql) => sql`update teams set archived_at = now() where id = ${team}`);
			const archived = "403 This team is archived. Restore it to change it.";
			assert.strictEqual(outcome(await setMember("boss", team, "bob", "member")), archived);
			assert.strictEqual(outcome(await setMember("ana", team, "bob", "member")), archived);
			assert.strictEqual(outcome(await call<Refusal>("boss", "PATCH", `/api/admin/teams/${team}`, { name: "Dusty" })), archived);
			assert.notInclude((await call<List>("ana", "GET", "/api/admin/teams")).body.teams.map((each) => each.id), team, "not in a team admin's list");
			assert.deepInclude((await call<List>("boss", "GET", "/api/admin/teams")).body.teams.find((each) => each.id === team), { archived: true });
		});
	});
});
