/**
 * Archive, restore and delete a team, and a person's own teams (GET /api/teams/mine),
 * through the routes (routes.ts), on a real Postgres (TEST_DATABASE_URL): what an archived
 * team still gives and refuses, what Restore brings back, what Delete takes with it, and
 * an archive that a concurrent invite and share wait for.
 */
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { WorkspaceDetail } from "../workspaces/Workspaces.ts";
import type { MyTeam } from "./Teams.ts";
import {
	base,
	call,
	create,
	database,
	emailOf,
	holdEvents,
	holdOpen,
	joinTeams,
	type List,
	type One,
	type Refusal,
	removeMember,
	runPromise,
	setMember,
	setUp,
	tag,
	tearDown,
	type Who,
	who,
	Workspaces,
} from "./test-app.ts";

type Answer = One & Refusal;
const archive = (by: Who, teamId: string) => call<Answer>(by, "POST", `/api/admin/teams/${teamId}/archive`);
const restore = (by: Who, teamId: string) => call<Answer>(by, "POST", `/api/admin/teams/${teamId}/restore`);
const remove = (by: Who, teamId: string) => call<Refusal>(by, "DELETE", `/api/admin/teams/${teamId}`);
const invite = (by: Who, teamId: string, email: string, role = "member") => call<Answer>(by, "POST", `/api/admin/teams/${teamId}/invites`, { email, role });
const cancel = (by: Who, teamId: string, email: string) => call<Answer>(by, "DELETE", `/api/admin/teams/${teamId}/invites/${encodeURIComponent(email)}`);
const mine = (person: Who) => call<{ teams: MyTeam[] }>(person, "GET", "/api/teams/mine");
const search = (person: Who, q: string) => call<{ teams: { id: string }[] }>(person, "GET", `/api/teams?q=${encodeURIComponent(q)}`);
const newEmail = (name: string) => `${name}-${tag}@new.invalid`;
const allowed = (email: string) => database((sql) => sql<{ team_only: boolean }>`select team_only from allowed_emails where email = ${email}`);

/** A workspace that `owner` makes and shares with the team. */
async function sharedWith(owner: Who, teamId: string, access = "edit") {
	const made = await call<{ workspace: WorkspaceDetail }>(owner, "POST", "/api/workspaces", { name: `Shared ${Math.random().toString(36).slice(2, 8)}` });
	assert.strictEqual(made.status, 201, JSON.stringify(made.body));
	const id = made.body.workspace.id;
	assert.strictEqual((await call(owner, "PUT", `/api/workspaces/${id}/teams/${teamId}`, { access })).status, 200);
	return id;
}
const accessOf = (person: Who, workspaceId: string) => runPromise(Workspaces.Workspaces.use((service) => service.accessOf(who[person], workspaceId)));

describe.skipIf(!base)("archive, restore and delete a team, and my teams", () => {
	beforeAll(setUp);
	afterAll(tearDown);

	it("lets only org admins archive and restore a team", async () => {
		const team = (await create("boss", "Archivists", "ana")).body.team.id;
		await setMember("boss", team, "bob", "member");
		for (const person of ["ana", "bob", "gus"] as const) {
			assert.strictEqual((await archive(person, team)).status, 403, person);
		}
		const archived = await archive("boss", team);
		assert.strictEqual(archived.status, 200, JSON.stringify(archived.body));
		assert.deepInclude(archived.body.team, { archived: true, canChangePeople: false });
		assert.strictEqual((await archive("boss2", team)).status, 200, "again: no change");
		assert.strictEqual((await restore("ana", team)).status, 403);
		assert.deepInclude((await restore("boss", team)).body.team, { archived: false, canChangePeople: true });
		assert.strictEqual((await archive("boss", "no-such-team")).status, 404);
	});

	it("hides an archived team from its team admins, as their list does, but not from org admins", async () => {
		const team = (await create("boss", "Shelved", "ana")).body.team.id;
		await archive("boss", team);
		assert.strictEqual((await call("ana", "GET", `/api/admin/teams/${team}`)).status, 404);
		assert.notInclude((await call<List>("ana", "GET", "/api/admin/teams")).body.teams.map((each) => each.id), team);
		assert.deepInclude((await call<One>("boss", "GET", `/api/admin/teams/${team}`)).body.team, { id: team, archived: true });
		await restore("boss", team);
		assert.strictEqual((await call("ana", "GET", `/api/admin/teams/${team}`)).status, 200);
	});

	it("stops the team's grants at once, keeps them, and brings them back on restore", async () => {
		const team = (await create("boss", "Readers", "ana")).body.team.id;
		await setMember("boss", team, "bob", "member");
		const workspace = await sharedWith("cy", team);
		assert.strictEqual(await accessOf("bob", workspace), "edit");

		await archive("boss", team);
		assert.strictEqual(await accessOf("bob", workspace), "none");
		const detail = await call<{ workspace: WorkspaceDetail }>("cy", "GET", `/api/workspaces/${workspace}`);
		assert.deepInclude(detail.body.workspace.teams?.[0], { id: team, archived: true, access: "edit" }, "the grant is kept");

		await restore("boss", team);
		assert.strictEqual(await accessOf("bob", workspace), "edit");
	});

	it("refuses every change to an archived team's people, to org admins too, and its rename", async () => {
		const team = (await create("boss", "Frozen", "ana")).body.team.id;
		await setMember("boss", team, "bob", "member");
		const email = newEmail("ivy");
		await invite("ana", team, email);
		await archive("boss", team);

		const archivedMessage = "This team is archived. Restore it to change it.";
		for (const by of ["boss", "ana"] as const) {
			const changes = [
				await setMember(by, team, "cy", "member"),
				await setMember(by, team, "bob", "admin"),
				await removeMember(by, team, "bob"),
				await invite(by, team, newEmail("jo")),
				await cancel(by, team, email),
				await call<Refusal>(by, "PATCH", `/api/admin/teams/${team}`, { name: "Thawed" }),
			];
			for (const change of changes) assert.deepStrictEqual([change.status, change.body.error], [403, by === "ana" && change === changes[5] ? "Only org admins can do this." : archivedMessage]);
		}
		const after = (await call<One>("boss", "GET", `/api/admin/teams/${team}`)).body.team;
		assert.deepStrictEqual(after.members.map((member) => member.id).sort(), [who.ana, who.bob].sort());
		assert.deepStrictEqual(after.invites.map((each) => each.email), [email]);
	});

	it("hides an archived team from the share picker and from my teams, and applies its invites at first sign-in", async () => {
		const team = (await create("boss", "Hidden ones", "ana")).body.team.id;
		const email = newEmail("kai");
		await invite("ana", team, email, "admin");
		await archive("boss", team);
		assert.deepStrictEqual((await search("bob", "Hidden ones")).body.teams, []);
		assert.notInclude((await mine("ana")).body.teams.map((each) => each.id), team);

		const id = `kai-${tag}`;
		await database((sql) => sql`insert into users (id, name, email, role) values (${id}, '', ${email}, 'user')`);
		await joinTeams({ id, email });
		const restored = (await restore("boss", team)).body.team;
		assert.deepInclude(restored.members.find((member) => member.id === id), { role: "admin" });
		assert.deepStrictEqual(restored.invites, []);
		assert.deepStrictEqual((await search("bob", "Hidden ones")).body.teams.map((each) => each.id), [team]);
	});

	it("lists my active teams with their members, and nothing for someone in no team", async () => {
		const [first, second] = [(await create("boss", "Mine alpha", "dan")).body.team.id, (await create("boss", "Mine beta", "cy", "Second one")).body.team.id];
		await setMember("boss", first, "fay", "member");
		await setMember("boss", second, "dan", "member");
		const answer = await mine("dan");
		assert.strictEqual(answer.status, 200);
		const found = answer.body.teams.filter((each) => each.id === first || each.id === second);
		assert.deepStrictEqual(found, [
			{
				id: first,
				name: "Mine alpha",
				description: "",
				role: "admin",
				members: [
					{ id: who.dan, name: "dan", email: emailOf("dan"), role: "admin" },
					{ id: who.fay, name: "fay", email: emailOf("fay"), role: "member" },
				],
			},
			{
				id: second,
				name: "Mine beta",
				description: "Second one",
				role: "member",
				members: [
					{ id: who.cy, name: "cy", email: emailOf("cy"), role: "admin" },
					{ id: who.dan, name: "dan", email: emailOf("dan"), role: "member" },
				],
			},
		]);
		assert.deepStrictEqual((await mine("gus")).body.teams, []);
	});

	it("deletes an archived team only, for org admins only, with its members, invites and grants", async () => {
		const team = (await create("boss", "Doomed", "ana")).body.team.id;
		await setMember("boss", team, "bob", "member");
		const workspace = await sharedWith("cy", team);
		const email = newEmail("lou");
		await invite("ana", team, email);

		const active = await remove("boss", team);
		assert.deepStrictEqual([active.status, active.body.error], [403, "Archive this team before you delete it."]);
		await archive("boss", team);
		const detail = (await call<One>("boss", "GET", `/api/admin/teams/${team}`)).body.team;
		assert.deepInclude(detail, { grantCount: 1 });
		assert.strictEqual((await remove("ana", team)).status, 403, "a team admin");

		assert.strictEqual((await remove("boss", team)).status, 200);
		assert.strictEqual((await call("boss", "GET", `/api/admin/teams/${team}`)).status, 404);
		const left = await database(
			(sql) => sql<{ members: number; invites: number; grants: number }>`
				select (select count(*)::int from team_members where team_id = ${team}) as members,
					(select count(*)::int from team_invites where team_id = ${team}) as invites,
					(select count(*)::int from workspace_teams where team_id = ${team}) as grants`,
		);
		assert.deepStrictEqual(left, [{ members: 0, invites: 0, grants: 0 }]);
		assert.lengthOf(await allowed(email), 0, "no way in is left");
		assert.strictEqual(await accessOf("bob", workspace), "none");
		assert.strictEqual((await remove("boss", team)).status, 404);
	});

	it("keeps an email's way in that another team's invite or an org admin holds, when a team is deleted", async () => {
		const [doomed, other] = [(await create("boss", "Doomed two", "ana")).body.team.id, (await create("boss", "Stays", "cy")).body.team.id];
		const [shared, direct, account] = [newEmail("max"), newEmail("ned"), newEmail("oz")];
		await invite("ana", doomed, shared);
		await invite("cy", other, shared);
		await invite("ana", doomed, direct);
		assert.strictEqual((await call("boss", "POST", "/api/admin/invites", { emails: [direct] })).status, 200);
		await invite("ana", doomed, account);
		// An account made outside the join: the email signs in with it.
		await database((sql) => sql`insert into users (id, name, email, role) values (${`oz-${tag}`}, '', ${account}, 'user')`);
		await archive("boss", doomed);
		assert.strictEqual((await remove("boss", doomed)).status, 200);

		assert.lengthOf(await allowed(shared), 1);
		assert.deepStrictEqual(await allowed(direct), [{ team_only: false }]);
		assert.lengthOf(await allowed(account), 1);
	});

	it("logs the archive, the restore and the delete", async () => {
		const team = (await create("boss", "Logged", "ana")).body.team.id;
		await setMember("boss", team, "bob", "member");
		await invite("ana", team, newEmail("pia"));
		await sharedWith("cy", team, "ask");
		await archive("boss", team);
		await restore("boss", team);
		await archive("boss", team);
		await remove("boss", team);
		const logged = await database(
			(sql) => sql<{ action: string; target: string | null; before: unknown; after: unknown }>`
				select action, target, before, after from admin_events
				where coalesce(after, before)->>'team' = ${team} and action in ('archive-team', 'restore-team', 'delete-team') order by id`,
		);
		const named = { team, name: "Logged" };
		assert.deepStrictEqual(logged, [
			{ action: "archive-team", target: null, before: null, after: named },
			{ action: "restore-team", target: null, before: null, after: named },
			{ action: "archive-team", target: null, before: null, after: named },
			{ action: "delete-team", target: null, before: { ...named, members: 2, invites: 1, grants: 1 }, after: null },
		]);
	});

	it("starts a delete again, rather than deadlock, when an invite came in while it waited for the team", async () => {
		const team = (await create("boss", "Deadlock", "ana")).body.team.id;
		await archive("boss", team);
		const email = newEmail("late");

		// G holds the team's row, as a restore, invite and archive again would. Delete D waits for it.
		const g = await holdOpen((sql) =>
			Effect.gen(function* () {
				yield* sql`select id from teams where id = ${team} for no key update`;
				yield* sql`insert into team_invites (team_id, email, role, invited_by) values (${team}, ${email}, 'member', ${who.boss})`;
			}),
		);
		const deleted = remove("boss", team);
		await g.waiting([deleted]);
		// H takes the new email's lock, then waits for the team's row behind D: the order of Teams.ts.
		const h = database((sql) =>
			sql.withTransaction(
				Effect.gen(function* () {
					yield* sql`select pg_advisory_xact_lock(hashtext(${`ponder-invite:${email}`}))`;
					yield* sql`select id from teams where id = ${team} for no key update`;
				}),
			),
		);
		await g.waiting([deleted, h]);
		await g.release();
		await h;
		const answer = await deleted;
		assert.strictEqual(answer.status, 200, JSON.stringify(answer.body));
		assert.deepEqual([...(await database((sql) => sql`select id from teams where id = ${team}`))], []);
	});

	it("makes an invite and a share wait for an archive, and then refuses them", async () => {
		const team = (await create("boss", "Racing", "ana")).body.team.id;
		const workspace = (await call<{ workspace: WorkspaceDetail }>("cy", "POST", "/api/workspaces", { name: `Race ${tag}` })).body.workspace.id;
		const events = await holdEvents();
		// The archive wrote its row and waits to commit.
		const archived = archive("boss", team);
		await events.waiting([archived]);
		const invited = invite("ana", team, newEmail("quo"));
		const shared = call<Refusal>("cy", "PUT", `/api/workspaces/${workspace}/teams/${team}`, { access: "ask" });
		await events.waiting([archived, invited, shared]);
		await events.release();
		const [a, i, s] = await Promise.all([archived, invited, shared]);
		assert.strictEqual(a.status, 200);
		assert.deepStrictEqual([i.status, i.body.error], [403, "This team is archived. Restore it to change it."]);
		assert.deepStrictEqual([s.status, s.body.error], [403, "This team is archived, so it can't be added."]);
		const after = (await call<One>("boss", "GET", `/api/admin/teams/${team}`)).body.team;
		assert.deepStrictEqual(after.invites, []);
		assert.strictEqual(after.grantCount, 0);
	});
});
