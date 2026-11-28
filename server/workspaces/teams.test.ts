/**
 * Team grants on workspaces (docs/teams-plan.md, ticket 3), through the HTTP routes, on a
 * real Postgres (TEST_DATABASE_URL), in a schema of their own that the last step drops:
 * the team search of the share picker, who gets access from a team, the list, the detail
 * and the activity log. The routes run behind a stand-in for the session check of app.ts,
 * which takes the person from a header. Archived teams are set by hand (archived_at):
 * the archive action comes later.
 */
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import { Hono } from "hono";
import type { SignedInEnv } from "../auth.ts";
import type { TeamMatch } from "../teams/Teams.ts";
import { jsonBody } from "../test-json.ts";
import { base, USERS_TABLE, useTestSchema } from "./test-env.ts";
import type { WorkspaceDetail, WorkspaceSummary } from "./Workspaces.ts";

const tag = Math.random().toString(36).slice(2, 10);
const schema = `test_workspace_teams_${tag}`;
useTestSchema(schema);

const { runPromise, dispose } = await import("../runtime/runtime.ts");
const Threads = await import("../threads/Threads.ts");
const AdminEvents = await import("../admin/AdminEvents.ts");
const Invites = await import("../people/Invites.ts");
const Runs = await import("../telemetry/Runs.ts");
const Workspaces = await import("./Workspaces.ts");
const Teams = await import("../teams/Teams.ts");
const { workspacesApi } = await import("./routes.ts");
const { teamsApi } = await import("../teams/routes.ts");

/** The people: an org admin and five others. */
const who = { boss: `boss-${tag}`, ana: `ana-${tag}`, bob: `bob-${tag}`, cy: `cy-${tag}`, dan: `dan-${tag}`, eve: `eve-${tag}` } as const;
type Who = keyof typeof who;

const app = new Hono<SignedInEnv>()
	.use("*", async (c, next) => {
		const id = c.req.header("x-test-user")!;
		c.set("user", { id, email: `${id}@example.invalid`, name: id } as SignedInEnv["Variables"]["user"]);
		await next();
	})
	.route("/api/workspaces", workspacesApi)
	.route("/api/teams", teamsApi);

type One = { workspace: WorkspaceDetail };
type List = { workspaces: WorkspaceSummary[] };
type Found = { teams: TeamMatch[] };
type Refusal = { error: string };
async function call<Body = unknown>(person: Who, method: string, path: string, json?: unknown): Promise<{ status: number; body: Body }> {
	const headers: Record<string, string> = { "x-test-user": who[person] };
	if (json !== undefined) headers["Content-Type"] = "application/json";
	const response = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
	return { status: response.status, body: await jsonBody<Body>(response) };
}
const database = <A>(work: (sql: PgClient.PgClient) => Effect.Effect<A, unknown>) => runPromise(PgClient.PgClient.use(work).pipe(Effect.orDie));
const actor = (person: Who) => ({ id: who[person], email: `${who[person]}@example.invalid` });
const access = (person: Who, workspaceId: string) => runPromise(Workspaces.Workspaces.use((workspaces) => workspaces.accessOf(who[person], workspaceId)));

/** A team made by the org admin, with its first admin and members. */
async function team(name: string, admin: Who, members: Who[] = []) {
	return runPromise(
		Teams.Teams.use((teams) =>
			Effect.gen(function* () {
				const made = yield* teams.create(actor("boss"), { name, description: "", adminUserId: who[admin] });
				for (const member of members) yield* teams.setMember(actor("boss"), made.id, who[member], "member");
				return made.id;
			}),
		),
	);
}
const joinTeam = (teamId: string, person: Who) => runPromise(Teams.Teams.use((teams) => teams.setMember(actor("boss"), teamId, who[person], "member")));
const leaveTeam = (teamId: string, person: Who) => runPromise(Teams.Teams.use((teams) => teams.removeMember(actor("boss"), teamId, who[person])));
const archive = (teamId: string, archived = true) => database((sql) => sql`update teams set archived_at = ${archived ? new Date() : null} where id = ${teamId}`);

async function create(person: Who, name: string) {
	const answer = await call<One>(person, "POST", "/api/workspaces", { name });
	assert.strictEqual(answer.status, 201, JSON.stringify(answer.body));
	return answer.body.workspace.id;
}
const setTeam = (by: Who, workspaceId: string, teamId: string, access: string) => call<One & Refusal>(by, "PUT", `/api/workspaces/${workspaceId}/teams/${teamId}`, { access });
const removeTeam = (by: Who, workspaceId: string, teamId: string) => call<One & Refusal>(by, "DELETE", `/api/workspaces/${workspaceId}/teams/${teamId}`);
const auditedActions = (workspaceId: string) =>
	database((sql) => sql<{ action: string }>`select action from admin_events where coalesce(after, before)->>'workspace' = ${workspaceId} order by id`).then((rows) =>
		rows.map((row) => row.action),
	);
const search = (person: Who, q: string) => call<Found>(person, "GET", `/api/teams?q=${encodeURIComponent(q)}`);

describe.skipIf(!base)("team grants on workspaces", () => {
	beforeAll(async () => {
		await database((sql) =>
			Effect.gen(function* () {
				yield* sql.unsafe(`create schema if not exists ${schema}`);
				yield* sql.unsafe(USERS_TABLE);
				for (const person of Object.keys(who) as Who[]) {
					yield* sql`insert into users (id, name, email, role) values (${who[person]}, ${person}, ${`${person}-${tag}@example.invalid`}, ${person === "boss" ? "admin" : "user"})`;
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
			}),
		);
	});

	afterAll(async () => {
		if (base) await database((sql) => sql.unsafe(`drop schema if exists ${schema} cascade`));
		await dispose();
	});

	it("finds active teams by name for anyone, without case, at most 20, with their member count and never their members", async () => {
		const hr = await team(`HR ${tag}`, "ana", ["bob", "cy"]);
		const gone = await team(`HR old ${tag}`, "ana");
		await archive(gone);
		for (let n = 0; n < 22; n++) await team(`Many ${n} ${tag}`, "dan");

		const found = await search("eve", `hr ${tag}`);
		assert.strictEqual(found.status, 200);
		assert.deepStrictEqual(found.body.teams, [{ id: hr, name: `HR ${tag}`, memberCount: 3 }], "the archived team is not found");
		assert.lengthOf((await search("eve", `many`)).body.teams, 20);
		assert.deepStrictEqual((await search("eve", "%")).body.teams, [], "% is not a wildcard");
		assert.notInclude(JSON.stringify((await search("eve", "")).body), who.bob);
	});

	it("gives every member of a team the access the team was added with, and shows the team to people who can share", async () => {
		const ops = await team(`Ops ${tag}`, "bob", ["cy"]);
		const notes = await create("ana", "Ops notes");
		assert.strictEqual(await access("cy", notes), "none");

		const added = await setTeam("ana", notes, ops, "ask");
		assert.strictEqual(added.status, 200, JSON.stringify(added.body));
		assert.deepStrictEqual(added.body.workspace.teams, [{ id: ops, name: `Ops ${tag}`, memberCount: 2, access: "ask", archived: false }]);
		assert.deepInclude(added.body.workspace, { teamCount: 1, memberCount: 0, members: [] });
		assert.strictEqual(await access("bob", notes), "ask", "a team admin is a member of the team");
		assert.strictEqual(await access("cy", notes), "ask");
		assert.strictEqual(await access("dan", notes), "none");
		assert.strictEqual((await call<One>("cy", "GET", `/api/workspaces/${notes}`)).body.workspace.teams, null, "a person who can only ask does not see the teams");

		const raised = await setTeam("ana", notes, ops, "edit");
		assert.strictEqual(raised.body.workspace.teams?.[0]?.access, "edit");
		assert.strictEqual(await access("cy", notes), "edit");
		const seen = (await call<One>("cy", "GET", `/api/workspaces/${notes}`)).body.workspace;
		assert.deepInclude(seen, { access: "edit", canShare: true, teamCount: 1 });
		assert.lengthOf(seen.teams ?? [], 1, "an editor by their team sees the teams");
		assert.deepStrictEqual(await auditedActions(notes), [], "a private workspace is not logged");
	});

	it("refuses a team grant from a person who can't share, and answers 404 for a workspace they can't use or a team that does not exist", async () => {
		const ops = await team(`Refused ${tag}`, "bob");
		const notes = await create("ana", "Refused notes");
		await call("ana", "PUT", `/api/workspaces/${notes}/members/${who.dan}`, { access: "ask" });

		const asker = await setTeam("dan", notes, ops, "ask");
		assert.deepStrictEqual([asker.status, asker.body], [403, { error: "Only the owner and people who can edit can share this workspace." }] as unknown[]);
		assert.strictEqual((await removeTeam("dan", notes, ops)).status, 403);
		assert.strictEqual((await setTeam("eve", notes, ops, "ask")).status, 404);
		assert.strictEqual((await removeTeam("eve", notes, ops)).status, 404);
		const unknown = await setTeam("ana", notes, `no-such-${tag}`, "ask");
		assert.deepStrictEqual([unknown.status, unknown.body], [404, { error: "Not found" }] as unknown[]);
		assert.strictEqual((await setTeam("ana", notes, ops, "owner")).status, 400);
		assert.strictEqual(await access("bob", notes), "none", "nothing changed");
	});

	it("takes a team's access away when the grant is removed", async () => {
		const ops = await team(`Removed ${tag}`, "bob");
		const notes = await create("ana", "Removed notes");
		await setTeam("ana", notes, ops, "edit");
		const removed = await removeTeam("ana", notes, ops);
		assert.strictEqual(removed.status, 200);
		assert.deepInclude(removed.body.workspace, { teams: [], teamCount: 0 });
		assert.strictEqual(await access("bob", notes), "none");
		assert.strictEqual((await removeTeam("ana", notes, ops)).status, 200, "removing a team that was not added changes nothing");
	});

	it("is live: a person added to the team gets access at once, and one removed loses it, unless a grant of their own or another team's keeps it", async () => {
		const hr = await team(`Live HR ${tag}`, "bob");
		const tfss = await team(`Live TFSS ${tag}`, "bob");
		const notes = await create("ana", "Live notes");
		await setTeam("ana", notes, hr, "edit");
		await setTeam("ana", notes, tfss, "ask");

		await joinTeam(hr, "dan");
		assert.strictEqual(await access("dan", notes), "edit");
		await leaveTeam(hr, "dan");
		assert.strictEqual(await access("dan", notes), "none");

		await joinTeam(hr, "cy");
		await joinTeam(tfss, "cy");
		await call("ana", "PUT", `/api/workspaces/${notes}/members/${who.eve}`, { access: "ask" });
		await joinTeam(hr, "eve");
		assert.deepStrictEqual([await access("cy", notes), await access("eve", notes)], ["edit", "edit"], "the highest grant wins");
		await leaveTeam(hr, "cy");
		await leaveTeam(hr, "eve");
		assert.strictEqual(await access("cy", notes), "ask", "another team's grant keeps it");
		assert.strictEqual(await access("eve", notes), "ask", "their own grant keeps it");
	});

	it("gives nothing from an archived team, keeps its grant, lets it be changed or removed, and refuses to add it", async () => {
		const old = await team(`Archived ${tag}`, "bob", ["cy"]);
		const notes = await create("ana", "Archived notes");
		const other = await create("ana", "Other notes");
		await setTeam("ana", notes, old, "ask");
		await archive(old);

		assert.strictEqual(await access("cy", notes), "none");
		const seen = (await call<One>("ana", "GET", `/api/workspaces/${notes}`)).body.workspace;
		assert.deepInclude(seen, { teamCount: 0 });
		assert.deepStrictEqual(seen.teams, [{ id: old, name: `Archived ${tag}`, memberCount: 2, access: "ask", archived: true }]);
		assert.notInclude(
			(await call<List>("cy", "GET", "/api/workspaces")).body.workspaces.map((workspace) => workspace.id),
			notes,
		);

		const refused = await setTeam("ana", other, old, "ask");
		assert.deepStrictEqual([refused.status, refused.body], [403, { error: "This team is archived, so it can't be added." }] as unknown[]);
		const changed = await setTeam("ana", notes, old, "edit");
		assert.strictEqual(changed.status, 200);
		assert.strictEqual(changed.body.workspace.teams?.[0]?.access, "edit");
		assert.strictEqual(await access("cy", notes), "none");

		await archive(old, false);
		assert.strictEqual(await access("cy", notes), "edit", "restored, the grant gives access again");
		await archive(old);
		assert.deepInclude((await removeTeam("ana", notes, old)).body.workspace, { teams: [] });
		await archive(old, false);
		assert.strictEqual(await access("cy", notes), "none");
	});

	it("lists the workspaces of a person's active teams, with the access the teams give and the count of teams", async () => {
		const sales = await team(`Sales ${tag}`, "bob", ["dan"]);
		const notes = await create("ana", "Sales notes");
		await setTeam("ana", notes, sales, "ask");
		const listOf = async (person: Who) => (await call<List>(person, "GET", "/api/workspaces")).body.workspaces.find((workspace) => workspace.id === notes);

		assert.deepInclude(await listOf("dan"), { access: "ask", memberCount: 0, teamCount: 1 });
		assert.deepInclude(await listOf("ana"), { access: "owner", teamCount: 1 });
		assert.isUndefined(await listOf("eve"));
		await archive(sales);
		assert.isUndefined(await listOf("dan"), "an archived team lists nothing");
		assert.deepInclude(await listOf("ana"), { teamCount: 0 });
		await archive(sales, false);
	});

	it("logs team grants on a workspace open to everyone, as person shares are, with each team's name and access", async () => {
		const ops = await team(`Logged ${tag}`, "bob");
		const handbook = await create("boss", "Team handbook");
		await setTeam("boss", handbook, ops, "ask");
		assert.deepStrictEqual(await auditedActions(handbook), [], "private: not logged");
		await call("boss", "PUT", `/api/workspaces/${handbook}/access`, { orgAccess: "ask" });
		await setTeam("boss", handbook, ops, "edit");
		await removeTeam("boss", handbook, ops);
		assert.deepStrictEqual(await auditedActions(handbook), ["share-workspace", "share-workspace", "share-workspace"]);
		const [changed] = await database(
			(sql) => sql<{ before: { teams: unknown }; after: { teams: unknown } }>`select before, after from admin_events where after->>'workspace' = ${handbook} order by id offset 1 limit 1`,
		);
		assert.deepStrictEqual(changed.before.teams, [{ id: ops, name: `Logged ${tag}`, access: "ask" }]);
		assert.deepStrictEqual(changed.after.teams, [{ id: ops, name: `Logged ${tag}`, access: "edit" }]);
	});

	it("deletes a workspace with its team grants", async () => {
		const ops = await team(`Deleted ${tag}`, "bob");
		const notes = await create("ana", "Deleted notes");
		await setTeam("ana", notes, ops, "ask");
		assert.strictEqual((await call("ana", "DELETE", `/api/workspaces/${notes}`)).status, 200);
		assert.strictEqual(await access("bob", notes), "none");
		assert.lengthOf(await database((sql) => sql`select 1 from workspace_teams where workspace_id = ${notes}`), 0);
	});
});
