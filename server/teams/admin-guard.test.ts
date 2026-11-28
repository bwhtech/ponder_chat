/**
 * The /api/admin guard (admin/routes.ts), a security boundary: a team admin reaches
 * /api/admin/me and /api/admin/teams*, and nothing else. The routes come from the admin
 * API itself, so a route added later is checked too. The app and the people are in
 * test-app.ts.
 */
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { adminApi, base, call, create, database, type Refusal, setMember, setUp, tearDown, type Who, who } from "./test-app.ts";

/** Every route of the admin API, with each :param filled in. */
function adminRoutes() {
	const seen = new Set<string>();
	return adminApi.routes
		.filter((route) => route.method !== "ALL")
		.map((route) => ({ method: route.method, path: `/api/admin${route.path.replace(/:[a-z]+(\{[^}]*\})?/gi, "1")}` }))
		.filter((route) => !seen.has(`${route.method} ${route.path}`) && seen.add(`${route.method} ${route.path}`));
}

const forTeamAdmins = (path: string) => /^\/api\/admin\/(me|teams)(\/|$)/.test(path);

describe.skipIf(!base)("the /api/admin guard", () => {
	let team = "";
	let other = "";
	beforeAll(async () => {
		await setUp();
		team = (await create("boss", "Guard", "ana")).body.team.id;
		other = (await create("boss", "Elsewhere", "cy")).body.team.id;
		await setMember("boss", team, "fay", "member");
	});
	afterAll(tearDown);

	it("finds the admin routes", () => {
		const paths = adminRoutes().map((route) => `${route.method} ${route.path}`);
		assert.include(paths, "GET /api/admin/people");
		assert.include(paths, "GET /api/admin/me");
		assert.include(paths, "POST /api/admin/teams/1/invites");
		assert.isAbove(paths.length, 40);
	});

	it("answers 403 to a team admin on every route that is not for team admins", async () => {
		const routes = adminRoutes().filter((route) => !forTeamAdmins(route.path));
		for (const route of routes) {
			const answer = await call<Refusal>("ana", route.method, route.path, route.method === "GET" ? undefined : {});
			assert.deepStrictEqual([answer.status, answer.body.error], [403, "Only admins can do this."], `${route.method} ${route.path}`);
		}
	});

	it("answers 403 to a member and to someone in no team on every route, /me too", async () => {
		for (const person of ["fay", "gus"] satisfies Who[]) {
			for (const route of adminRoutes()) {
				const answer = await call(person, route.method, route.path, route.method === "GET" ? undefined : {});
				assert.strictEqual(answer.status, 403, `${person} ${route.method} ${route.path}`);
			}
		}
	});

	it("answers 403 to a team admin on another team's routes", async () => {
		const routes: [string, string, unknown?][] = [
			["GET", `/api/admin/teams/${other}`],
			["PATCH", `/api/admin/teams/${other}`, { name: "Taken over" }],
			["PUT", `/api/admin/teams/${other}/members/${who.gus}`, { role: "member" }],
			["DELETE", `/api/admin/teams/${other}/members/${who.cy}`],
			["POST", `/api/admin/teams/${other}/invites`, { email: "stranger@example.invalid", role: "admin" }],
			["DELETE", `/api/admin/teams/${other}/invites/stranger@example.invalid`],
		];
		for (const [method, path, json] of routes) assert.strictEqual((await call("ana", method, path, json)).status, 403, `${method} ${path}`);
	});

	it("tells the admin shell what to show: the whole of /admin, or only the teams", async () => {
		assert.deepStrictEqual(await call("boss", "GET", "/api/admin/me"), { status: 200, body: { scope: "org" } });
		assert.deepStrictEqual(await call("ana", "GET", "/api/admin/me"), { status: 200, body: { scope: "team" } });
	});

	it("lets in no one whose only teams are archived", async () => {
		const shelf = (await create("boss", "Shelf", "dan")).body.team.id;
		assert.strictEqual((await call("dan", "GET", "/api/admin/me")).status, 200);
		await setMember("boss", shelf, "dan", "admin");
		await database((sql) => sql`update teams set archived_at = now() where id = ${shelf}`);
		assert.strictEqual((await call("dan", "GET", "/api/admin/me")).status, 403);
		assert.strictEqual((await call("dan", "GET", "/api/admin/teams")).status, 403);
	});
});

