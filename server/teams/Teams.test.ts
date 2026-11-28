/**
 * Teams through their HTTP routes (routes.ts, under /api/admin), on a real Postgres
 * (TEST_DATABASE_URL), in a schema of their own that the last step drops: who makes and
 * changes a team, who is in it with which role, the last-admin rule, and the activity log.
 * The routes run behind a stand-in for the session check of app.ts, which takes the
 * person from a header.
 */
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import { Hono } from "hono";
import type { SignedInEnv } from "../auth.ts";
import { jsonBody } from "../test-json.ts";
import { base, USERS_TABLE, useTestSchema } from "../workspaces/test-env.ts";
import type { Actor, TeamDetail, Teams as TeamsService, TeamSummary } from "./Teams.ts";

const tag = Math.random().toString(36).slice(2, 10);
const schema = `test_teams_${tag}`;
useTestSchema(schema);

const { runPromise, dispose } = await import("../runtime/runtime.ts");
const Threads = await import("../threads/Threads.ts");
const AdminEvents = await import("../admin/AdminEvents.ts");
const Invites = await import("../people/Invites.ts");
const Runs = await import("../telemetry/Runs.ts");
const Workspaces = await import("../workspaces/Workspaces.ts");
const Teams = await import("./Teams.ts");
const { adminApi } = await import("../admin/routes.ts");

/** The people: two org admins and five others, one of them banned. */
const who = { boss: `boss-${tag}`, boss2: `boss2-${tag}`, ana: `ana-${tag}`, bob: `bob-${tag}`, cy: `cy-${tag}`, dan: `dan-${tag}`, eve: `eve-${tag}` } as const;
type Who = keyof typeof who;

const app = new Hono<SignedInEnv>()
	.use("*", async (c, next) => {
		const id = c.req.header("x-test-user")!;
		c.set("user", { id, email: `${id}@example.invalid`, name: id } as SignedInEnv["Variables"]["user"]);
		await next();
	})
	.route("/api/admin", adminApi);

type One = { team: TeamDetail };
type List = { teams: TeamSummary[] };
type Refusal = { error: string };
async function call<Body = unknown>(person: Who, method: string, path: string, json?: unknown): Promise<{ status: number; body: Body }> {
	const headers: Record<string, string> = { "x-test-user": who[person] };
	if (json !== undefined) headers["Content-Type"] = "application/json";
	const response = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
	return { status: response.status, body: await jsonBody<Body>(response) };
}
const database = <A>(work: (sql: PgClient.PgClient) => Effect.Effect<A, unknown>) => runPromise(PgClient.PgClient.use(work).pipe(Effect.orDie));

const create = (by: Who, name: string, admin: Who, description = "") =>
	call<One & Refusal>(by, "POST", "/api/admin/teams", { name, description, adminUserId: who[admin] });
const setMember = (by: Who, teamId: string, person: Who | string, role: "member" | "admin" | "owner") =>
	call<One & Refusal>(by, "PUT", `/api/admin/teams/${teamId}/members/${person in who ? who[person as Who] : person}`, { role });
const removeMember = (by: Who, teamId: string, person: Who) => call<One & Refusal>(by, "DELETE", `/api/admin/teams/${teamId}/members/${who[person]}`);
const roles = (team: TeamDetail): string[][] => team.members.map((member) => [member.id, member.role]);

describe.skipIf(!base)("teams through their routes", () => {
	beforeAll(async () => {
		await database((sql) =>
			Effect.gen(function* () {
				yield* sql.unsafe(`create schema if not exists ${schema}`);
				yield* sql.unsafe(USERS_TABLE);
				for (const person of Object.keys(who) as Who[]) {
					yield* sql`insert into users (id, name, email, role, banned) values (${who[person]}, ${person}, ${`${person}-${tag}@example.invalid`}, ${person.startsWith("boss") ? "admin" : "user"}, ${person === "eve"})`;
				}
			}),
		);
		await runPromise(
			Effect.gen(function* () {
				yield* Threads.Threads.use((threads) => threads.migrate);
				yield* AdminEvents.AdminEvents.use((events) => events.migrate);
				yield* Runs.Runs.use((runs) => runs.migrate);
				yield* Workspaces.Workspaces.use((workspaces) => workspaces.migrate);
				yield* Invites.Invites.use((invites) => invites.migrate);
				yield* Teams.Teams.use((teams) => teams.migrate);
				// Twice, without a change.
				yield* Teams.Teams.use((teams) => teams.migrate);
			}),
		);
	});

	afterAll(async () => {
		if (base) await database((sql) => sql.unsafe(`drop schema if exists ${schema} cascade`));
		await dispose();
	});

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

	it("answers 403 to people who are not org admins, team admins too, on every team route", async () => {
		const team = (await create("boss", "Guarded", "ana")).body.team.id;
		const routes: [string, string, unknown?][] = [
			["GET", "/api/admin/teams"],
			["POST", "/api/admin/teams", { name: "Mine", adminUserId: who.ana }],
			["GET", `/api/admin/teams/${team}`],
			["PATCH", `/api/admin/teams/${team}`, { name: "Renamed" }],
			["PUT", `/api/admin/teams/${team}/members/${who.bob}`, { role: "member" }],
			["DELETE", `/api/admin/teams/${team}/members/${who.ana}`],
		];
		for (const person of ["ana", "bob"] as const) {
			for (const [method, path, json] of routes) assert.strictEqual((await call(person, method, path, json)).status, 403, `${person} ${method} ${path}`);
		}
		assert.deepStrictEqual(roles((await call<One>("boss", "GET", `/api/admin/teams/${team}`)).body.team), [[who.ana, "admin"]], "nothing changed");
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
	/**
	 * Team admins reach the service only from ticket 2's /api/admin guard on. Until then, these
	 * call the service as the routes will.
	 */
	describe("a team admin, through the service", () => {
		const actor = (person: Who): Actor => ({ id: who[person], email: `${person}@example.invalid` });
		const service = <A, E>(use: (teams: TeamsService["Service"]) => Effect.Effect<A, E>) => runPromise(Teams.Teams.use(use));
		const attempt = <A, E>(use: (teams: TeamsService["Service"]) => Effect.Effect<A, E>) =>
			runPromise(Teams.Teams.use(use).pipe(Effect.match({ onSuccess: () => "ok", onFailure: (error) => (error instanceof Teams.TeamRefused ? error.reason : String(error)) })));

		it("manages the people of their own team, but never leaves it without a team admin", async () => {
			const team = (await service((teams) => teams.create(actor("boss"), { name: `Ops ${tag}`, description: "", adminUserId: who.ana }))).id;
			assert.strictEqual(await attempt((teams) => teams.setMember(actor("ana"), team, who.bob, "member")), "ok");
			assert.strictEqual(await attempt((teams) => teams.setMember(actor("ana"), team, who.ana, "member")), "last-admin", "demotes themselves");
			assert.strictEqual(await attempt((teams) => teams.removeMember(actor("ana"), team, who.ana)), "last-admin", "removes themselves");
			assert.strictEqual(await attempt((teams) => teams.setMember(actor("ana"), team, who.bob, "admin")), "ok");
			assert.strictEqual(await attempt((teams) => teams.removeMember(actor("ana"), team, who.ana)), "ok", "another admin stays");
			assert.strictEqual(await attempt((teams) => teams.removeMember(actor("bob"), team, who.bob)), "last-admin");
			const detail = await service((teams) => teams.get(actor("bob"), team));
			assert.deepInclude(detail, { canOrganise: false, canChangePeople: true });
		});

		it("refuses members, other teams' admins and the org-admin actions", async () => {
			const team = (await service((teams) => teams.create(actor("boss"), { name: `Desk ${tag}`, description: "", adminUserId: who.ana }))).id;
			await service((teams) => teams.setMember(actor("ana"), team, who.bob, "member"));
			const other = (await service((teams) => teams.create(actor("boss"), { name: `Other ${tag}`, description: "", adminUserId: who.cy }))).id;
			assert.strictEqual(await attempt((teams) => teams.setMember(actor("bob"), team, who.dan, "member")), "needs-team-admin", "a member");
			assert.strictEqual(await attempt((teams) => teams.get(actor("bob"), team)), "needs-team-admin", "a member in /admin");
			assert.strictEqual(await attempt((teams) => teams.setMember(actor("cy"), team, who.dan, "member")), "needs-team-admin", "another team's admin");
			assert.strictEqual(await attempt((teams) => teams.get(actor("ana"), other)), "needs-team-admin");
			assert.strictEqual(await attempt((teams) => teams.update(actor("ana"), team, { name: "Mine now" })), "needs-org-admin");
			assert.strictEqual(await attempt((teams) => teams.create(actor("ana"), { name: "Another", description: "", adminUserId: who.ana })), "needs-org-admin");
			const listed = (await service((teams) => teams.list(actor("ana")))).map((each) => each.id);
			assert.include(listed, team);
			assert.notInclude(listed, other, "only the teams they admin");
		});

		it("changes nothing in an archived team", async () => {
			const team = (await service((teams) => teams.create(actor("boss"), { name: `Shelf ${tag}`, description: "", adminUserId: who.ana }))).id;
			await database((sql) => sql`update teams set archived_at = now() where id = ${team}`);
			assert.strictEqual(await attempt((teams) => teams.setMember(actor("boss"), team, who.bob, "member")), "archived");
			assert.strictEqual(await attempt((teams) => teams.setMember(actor("ana"), team, who.bob, "member")), "archived");
			assert.strictEqual(await attempt((teams) => teams.update(actor("boss"), team, { name: "Dusty" })), "archived");
			assert.notInclude((await service((teams) => teams.list(actor("ana")))).map((each) => each.id), team, "not in a team admin's list");
			assert.deepInclude((await service((teams) => teams.list(actor("boss")))).find((each) => each.id === team), { archived: true });
		});
	});
});
