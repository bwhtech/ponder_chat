import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import { Hono } from "hono";
import type { SignedInEnv } from "../auth.ts";
import { jsonBody } from "../test-json.ts";
import { base, USERS_TABLE, useTestSchema } from "../workspaces/test-env.ts";
import type { TeamDetail, TeamSummary } from "./Teams.ts";

/**
 * The teams tests' app (*.test.ts here): the admin API on the app's runtime, on
 * TEST_DATABASE_URL, in a schema of the test file's own. The routes run behind a stand-in
 * for the session check of app.ts, which takes the person from a header. Each test file
 * that imports this gets its own copy, and so its own schema.
 *
 * Set `env` before the import for more of the environment, such as a mail server that
 * fails (invites.test.ts).
 */
export { base };

export const tag = Math.random().toString(36).slice(2, 10);
const schema = `test_teams_${tag}`;
useTestSchema(schema);

const runtime = await import("../runtime/runtime.ts");
export const { runPromise } = runtime;
const Threads = await import("../threads/Threads.ts");
const AdminEvents = await import("../admin/AdminEvents.ts");
const Invites = await import("../people/Invites.ts");
const Runs = await import("../telemetry/Runs.ts");
const Workspaces = await import("../workspaces/Workspaces.ts");
export const Teams = await import("./Teams.ts");
export const { adminApi } = await import("../admin/routes.ts");

/**
 * The people: two org admins and seven others. Eve is banned. Fay and gus are for the
 * guard's tests only: fay is only ever a member, and gus is in no team.
 */
const PEOPLE = ["boss", "boss2", "ana", "bob", "cy", "dan", "eve", "fay", "gus"] as const;
export type Who = (typeof PEOPLE)[number];
export const who = Object.fromEntries(PEOPLE.map((person) => [person, `${person}-${tag}`])) as Record<Who, string>;
export const emailOf = (person: Who) => `${person}-${tag}@example.invalid`;

const app = new Hono<SignedInEnv>()
	.use("*", async (c, next) => {
		const id = c.req.header("x-test-user")!;
		c.set("user", { id, email: `${id}@example.invalid`, name: id } as SignedInEnv["Variables"]["user"]);
		await next();
	})
	.route("/api/admin", adminApi);

export type One = { team: TeamDetail };
export type List = { teams: TeamSummary[] };
export type Refusal = { error: string };

export async function call<Body = unknown>(person: Who, method: string, path: string, json?: unknown): Promise<{ status: number; body: Body }> {
	const headers: Record<string, string> = { "x-test-user": who[person] };
	if (json !== undefined) headers["Content-Type"] = "application/json";
	const response = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
	return { status: response.status, body: await jsonBody<Body>(response) };
}

export const database = <A>(work: (sql: PgClient.PgClient) => Effect.Effect<A, unknown>) => runPromise(PgClient.PgClient.use(work).pipe(Effect.orDie));

export const create = (by: Who, name: string, admin: Who, description = "") =>
	call<One & Refusal>(by, "POST", "/api/admin/teams", { name, description, adminUserId: who[admin] });
export const setMember = (by: Who, teamId: string, person: Who | string, role: "member" | "admin" | "owner") =>
	call<One & Refusal>(by, "PUT", `/api/admin/teams/${teamId}/members/${person in who ? who[person as Who] : person}`, { role });
export const removeMember = (by: Who, teamId: string, person: Who) => call<One & Refusal>(by, "DELETE", `/api/admin/teams/${teamId}/members/${who[person]}`);
export const roles = (team: TeamDetail): string[][] => team.members.map((member) => [member.id, member.role]);

/** The schema, its users and every table the teams need. Run in beforeAll. */
export async function setUp() {
	await database((sql) =>
		Effect.gen(function* () {
			yield* sql.unsafe(`create schema if not exists ${schema}`);
			yield* sql.unsafe(USERS_TABLE);
			for (const person of PEOPLE) {
				yield* sql`insert into users (id, name, email, role, banned) values (${who[person]}, ${person}, ${emailOf(person)}, ${person.startsWith("boss") ? "admin" : "user"}, ${person === "eve"})`;
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
}

/** Drops the schema and stops the runtime. Run in afterAll. */
export async function tearDown() {
	if (base) await database((sql) => sql.unsafe(`drop schema if exists ${schema} cascade`));
	await runtime.dispose();
}
