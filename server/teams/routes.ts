import { type Context, Hono } from "hono";
import * as Effect from "effect/Effect";
import { z } from "zod";
import type { SignedInEnv } from "../auth.ts";
import * as Auth from "../auth/Auth.ts";
import { route } from "../runtime/route.ts";
import { validate } from "../validate.ts";
import * as Teams from "./Teams.ts";

/**
 * /api/admin/teams (Teams.ts), mounted in admin/routes.ts behind its guard, which lets in
 * org admins and team admins. The service checks each person's role in each team again. A
 * team that does not exist answers 404; a change the person may not make, 403 with a
 * message the page can show.
 *
 * /api/teams, for every signed-in person, mounted in app.ts: the share picker's search, and
 * the person's own teams.
 */
type Env = SignedInEnv;

/** One method of the service, as the person who asks, with the address they use Ponder at for the links in emails. */
const teams = <A, E>(c: Context<Env>, use: (service: Teams.Teams["Service"], actor: Teams.Actor) => Effect.Effect<A, E>) =>
	Effect.flatMap(Auth.appOrigin(c.req.raw.headers), (origin) =>
		Teams.Teams.use((service) => use(service, { id: c.get("user").id, email: c.get("user").email, origin })),
	);

/** A JSON body that fits the schema, or a 400 with the first problem. */
const body = <Schema extends z.ZodType>(schema: Schema) => validate("json", schema, { error: "Check the values and try again." });

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const name = z.string().trim().min(1).max(80);
const description = z.string().trim().max(500);
const role = z.enum(["member", "admin"]);

const createBody = z.object({ name, description: description.default(""), adminUserId: z.string().min(1) });
const updateBody = z.object({ name: name.optional(), description: description.optional() });
const memberBody = z.object({ role });
const inviteBody = z.object({ email: z.string().trim().toLowerCase().max(320).regex(EMAIL), role });
// A repeated or odd query value is ignored, not refused.
const searchQuery = z.object({ q: z.string().default("").catch("").transform((q) => q.slice(0, 200)) });

const notFound = (_: Teams.TeamNotFound, c: Context) => c.json({ error: "Not found" }, 404);
const refused = (error: Teams.TeamRefused, c: Context) => c.json({ error: error.message }, error.reason === "no-account" ? 400 : 403);
const nameTaken = (error: Teams.TeamNameTaken, c: Context) => c.json({ error: error.message }, 409);
const errors = { TeamNotFound: notFound, TeamRefused: refused } as const;

export const teamsAdminApi = new Hono<Env>()
	.get("/", (c) => route(c, Effect.map(teams(c, (service, actor) => service.list(actor)), (list) => c.json({ teams: list }))))

	.post("/", body(createBody), (c) =>
		route(c, Effect.map(teams(c, (service, actor) => service.create(actor, c.req.valid("json"))), (team) => c.json({ team }, 201)), {
			TeamRefused: refused,
			TeamNameTaken: nameTaken,
		}),
	)

	.get("/:id", (c) => route(c, Effect.map(teams(c, (service, actor) => service.get(actor, c.req.param("id"))), (team) => c.json({ team })), errors))

	.patch("/:id", body(updateBody), (c) =>
		route(c, Effect.map(teams(c, (service, actor) => service.update(actor, c.req.param("id"), c.req.valid("json"))), (team) => c.json({ team })), {
			...errors,
			TeamNameTaken: nameTaken,
		}),
	)

	// One person at a time. Each answers the team as the person sees it now.
	.put("/:id/members/:userId", body(memberBody), (c) =>
		route(
			c,
			Effect.map(teams(c, (service, actor) => service.setMember(actor, c.req.param("id"), c.req.param("userId"), c.req.valid("json").role)), (team) => c.json({ team })),
			errors,
		),
	)

	.delete("/:id/members/:userId", (c) =>
		route(c, Effect.map(teams(c, (service, actor) => service.removeMember(actor, c.req.param("id"), c.req.param("userId"))), (team) => c.json({ team })), errors),
	)

	// An email: its account joins at once ({ added: true }), or it is invited ({ invited: true }). Both with the team.
	.post("/:id/invites", body(inviteBody), (c) => {
		const { email, role } = c.req.valid("json");
		return route(c, Effect.map(teams(c, (service, actor) => service.invite(actor, c.req.param("id"), email, role)), (result) => c.json(result)), errors);
	})

	// Org admins. Archive and restore answer the team; delete only an archived team.
	.post("/:id/archive", (c) => route(c, Effect.map(teams(c, (service, actor) => service.archive(actor, c.req.param("id"))), (team) => c.json({ team })), errors))
	.post("/:id/restore", (c) => route(c, Effect.map(teams(c, (service, actor) => service.restore(actor, c.req.param("id"))), (team) => c.json({ team })), errors))
	.delete("/:id", (c) => route(c, Effect.map(teams(c, (service, actor) => service.remove(actor, c.req.param("id"))), () => c.json({ deleted: true as const })), errors))

	.delete("/:id/invites/:email", (c) =>
		route(
			c,
			Effect.map(teams(c, (service, actor) => service.cancelInvite(actor, c.req.param("id"), c.req.param("email").trim().toLowerCase())), (team) => c.json({ team })),
			errors,
		),
	);

/**
 * GET /api/teams?q=: active teams by name, at most 20, with their member count. Never their members.
 * GET /api/teams/mine: the person's own active teams, with their members (Settings > Teams).
 */
export const teamsApi = new Hono<Env>()
	.get("/", validate("query", searchQuery), (c) =>
		route(c, Effect.map(Teams.Teams.use((service) => service.search(c.req.valid("query").q)), (found) => c.json({ teams: found }))),
	)
	.get("/mine", (c) => route(c, Effect.map(Teams.Teams.use((service) => service.mine(c.get("user").id)), (found) => c.json({ teams: found }))));
