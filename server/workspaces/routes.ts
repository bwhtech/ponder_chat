import { type Context, Hono } from "hono";
import * as Effect from "effect/Effect";
import { z } from "zod";
import type { SignedInEnv } from "../auth.ts";
import * as Accounts from "../people/Accounts.ts";
import { route } from "../runtime/route.ts";
import { validate } from "../validate.ts";
import * as Workspaces from "./Workspaces.ts";

/**
 * /api/workspaces and /api/people (Workspaces.ts). A workspace the person cannot use
 * answers 404, never 403, so an answer does not show that it exists. A person who can use
 * it, but not for this, gets 403 with a message the page can show.
 */
type Env = SignedInEnv;

const actorOf = (c: Context<Env>): Workspaces.Actor => ({ id: c.get("user").id, email: c.get("user").email });
const workspaces = <A, E>(use: (service: Workspaces.Workspaces["Service"]) => Effect.Effect<A, E>) => Workspaces.Workspaces.use(use);

/** A JSON body that fits the schema, or a 400 with the first problem. */
const body = <Schema extends z.ZodType>(schema: Schema) => validate("json", schema, { error: "Check the values and try again." });

const name = z.string().trim().min(1).max(80);
const description = z.string().trim().max(500);
const instructions = z.string().max(20_000);
const icon = z.string().trim().max(40).nullable().transform((value) => value || null);

const createBody = z.object({
	kind: z.enum(["org", "private"]).default("private"),
	name,
	description: description.default(""),
	instructions: instructions.default(""),
	icon: icon.default(null),
});
const updateBody = z.object({ name: name.optional(), description: description.optional(), instructions: instructions.optional(), icon: icon.optional() });
const sharingBody = z.object({
	kind: z.enum(["org", "private"]),
	members: z.array(z.object({ userId: z.string().min(1).max(200), access: z.enum(["ask", "edit"]) })).max(500).default([]),
});
// A repeated or odd query value is ignored, not refused.
const peopleQuery = z.object({ q: z.string().default("").catch("").transform((q) => q.slice(0, 200)) });

const notFound = (_: Workspaces.WorkspaceNotFound, c: Context) => c.json({ error: "Not found" }, 404);
const refused = (error: Workspaces.WorkspaceRefused, c: Context) => c.json({ error: error.message }, 403);

export const workspacesApi = new Hono<Env>()
	// The sidebar's list. Also in the chat page's boot data (boot-page.ts).
	.get("/", (c) => route(c, Effect.map(workspaces((service) => service.list(actorOf(c).id)), (list) => c.json({ workspaces: list }))))

	.post("/", body(createBody), (c) =>
		route(c, Effect.map(workspaces((service) => service.create(actorOf(c), c.req.valid("json"))), (workspace) => c.json({ workspace }, 201)), {
			WorkspaceRefused: refused,
		}),
	)

	.get("/:id", (c) =>
		route(c, Effect.map(workspaces((service) => service.get(actorOf(c).id, c.req.param("id"))), (workspace) => c.json({ workspace })), {
			WorkspaceNotFound: notFound,
		}),
	)

	.patch("/:id", body(updateBody), (c) =>
		route(c, Effect.map(workspaces((service) => service.update(actorOf(c), c.req.param("id"), c.req.valid("json"))), (workspace) => c.json({ workspace })), {
			WorkspaceNotFound: notFound,
			WorkspaceRefused: refused,
		}),
	)

	.put("/:id/sharing", body(sharingBody), (c) =>
		route(c, Effect.map(workspaces((service) => service.share(actorOf(c), c.req.param("id"), c.req.valid("json"))), (workspace) => c.json({ workspace })), {
			WorkspaceNotFound: notFound,
			WorkspaceRefused: refused,
			UnknownPeople: (error, c) => c.json({ error: error.message }, 400),
		}),
	)

	.delete("/:id", (c) =>
		route(c, Effect.map(workspaces((service) => service.remove(actorOf(c), c.req.param("id"))), () => c.json({ ok: true })), {
			WorkspaceNotFound: notFound,
			WorkspaceRefused: refused,
		}),
	);

/** /api/people?q=: the people picker of the Share dialog. Any signed-in person; at most 20, with id, name and email. */
export const peopleApi = new Hono<Env>().get("/", validate("query", peopleQuery), (c) =>
	route(c, Effect.map(Accounts.Accounts.use((accounts) => accounts.search(c.req.valid("query").q)), (people) => c.json({ people }))),
);
