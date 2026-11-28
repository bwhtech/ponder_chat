import { type Context, Hono } from "hono";
import * as Effect from "effect/Effect";
import { z } from "zod";
import type { SignedInEnv } from "../auth.ts";
import { route } from "../runtime/route.ts";
import { validate } from "../validate.ts";
import * as Teams from "./Teams.ts";

/**
 * /api/admin/teams (Teams.ts), mounted in admin/routes.ts behind its admin check. The
 * service checks each person's role in each team again. A team that does not exist answers
 * 404; a change the person may not make, 403 with a message the page can show.
 *
 * /api/teams, for every signed-in person, mounted in app.ts: the share picker's search.
 */
type Env = SignedInEnv;

const actorOf = (c: Context<Env>): Teams.Actor => ({ id: c.get("user").id, email: c.get("user").email });
const teams = <A, E>(use: (service: Teams.Teams["Service"]) => Effect.Effect<A, E>) => Teams.Teams.use(use);

/** A JSON body that fits the schema, or a 400 with the first problem. */
const body = <Schema extends z.ZodType>(schema: Schema) => validate("json", schema, { error: "Check the values and try again." });

const name = z.string().trim().min(1).max(80);
const description = z.string().trim().max(500);
const role = z.enum(["member", "admin"]);

const createBody = z.object({ name, description: description.default(""), adminUserId: z.string().min(1) });
const updateBody = z.object({ name: name.optional(), description: description.optional() });
const memberBody = z.object({ role });
// A repeated or odd query value is ignored, not refused.
const searchQuery = z.object({ q: z.string().default("").catch("").transform((q) => q.slice(0, 200)) });

const notFound = (_: Teams.TeamNotFound, c: Context) => c.json({ error: "Not found" }, 404);
const refused = (error: Teams.TeamRefused, c: Context) => c.json({ error: error.message }, error.reason === "no-account" ? 400 : 403);
const nameTaken = (error: Teams.TeamNameTaken, c: Context) => c.json({ error: error.message }, 409);
const errors = { TeamNotFound: notFound, TeamRefused: refused } as const;

export const teamsAdminApi = new Hono<Env>()
	.get("/", (c) => route(c, Effect.map(teams((service) => service.list(actorOf(c))), (list) => c.json({ teams: list }))))

	.post("/", body(createBody), (c) =>
		route(c, Effect.map(teams((service) => service.create(actorOf(c), c.req.valid("json"))), (team) => c.json({ team }, 201)), {
			TeamRefused: refused,
			TeamNameTaken: nameTaken,
		}),
	)

	.get("/:id", (c) => route(c, Effect.map(teams((service) => service.get(actorOf(c), c.req.param("id"))), (team) => c.json({ team })), errors))

	.patch("/:id", body(updateBody), (c) =>
		route(c, Effect.map(teams((service) => service.update(actorOf(c), c.req.param("id"), c.req.valid("json"))), (team) => c.json({ team })), {
			...errors,
			TeamNameTaken: nameTaken,
		}),
	)

	// One person at a time. Each answers the team as the person sees it now.
	.put("/:id/members/:userId", body(memberBody), (c) =>
		route(
			c,
			Effect.map(teams((service) => service.setMember(actorOf(c), c.req.param("id"), c.req.param("userId"), c.req.valid("json").role)), (team) => c.json({ team })),
			errors,
		),
	)

	.delete("/:id/members/:userId", (c) =>
		route(c, Effect.map(teams((service) => service.removeMember(actorOf(c), c.req.param("id"), c.req.param("userId"))), (team) => c.json({ team })), errors),
	);

/** GET /api/teams?q=: active teams by name, at most 20, with their member count. Never their members. */
export const teamsApi = new Hono<Env>().get("/", validate("query", searchQuery), (c) =>
	route(c, Effect.map(teams((service) => service.search(c.req.valid("query").q)), (found) => c.json({ teams: found }))),
);
