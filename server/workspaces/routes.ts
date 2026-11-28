import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as Effect from "effect/Effect";
import { z } from "zod";
import { MAX_INSTRUCTIONS } from "../../shared/workspaces.ts";
import type { SignedInEnv } from "../auth.ts";
import { fileHeaders, MAX_FILE_BYTES } from "../files.ts";
import * as Accounts from "../people/Accounts.ts";
import { limitPerPerson } from "../rate-limit.ts";
import { route } from "../runtime/route.ts";
import { validate } from "../validate.ts";
import * as Documents from "./documents/Documents.ts";
import * as Workspaces from "./Workspaces.ts";

/**
 * /api/workspaces and /api/people (Workspaces.ts, documents/Documents.ts). A workspace
 * the person cannot use answers 404, never 403, so an answer does not show that it
 * exists. A person who can use it, but not for this, gets 403 with a message the page
 * can show. A document that is not in the workspace is a 404 too.
 *
 * GET /:id also takes the workspace's slug (slug.ts), as the page's address has it; the
 * other routes take its id, which the page has from that answer.
 */
type Env = SignedInEnv;

const actorOf = (c: Context<Env>): Workspaces.Actor => ({ id: c.get("user").id, email: c.get("user").email });
const workspaces = <A, E>(use: (service: Workspaces.Workspaces["Service"]) => Effect.Effect<A, E>) => Workspaces.Workspaces.use(use);
const documents = <A, E>(use: (service: Documents.Documents["Service"]) => Effect.Effect<A, E>) => Documents.Documents.use(use);

// The same limits as a chat attachment (app.ts).
const uploadLimit = bodyLimit({
	maxSize: MAX_FILE_BYTES + 64 * 1024,
	onError: (c) => c.json({ error: "That file is larger than 10 MB." }, 413),
});
const perPerson = limitPerPerson("upload", (c: Context<Env>) => c.get("user").id);

/** A JSON body that fits the schema, or a 400 with the first problem. */
const body = <Schema extends z.ZodType>(schema: Schema) => validate("json", schema, { error: "Check the values and try again." });

const name = z.string().trim().min(1).max(80);
const description = z.string().trim().max(500);
const instructions = z.string().max(MAX_INSTRUCTIONS);
const icon = z.string().trim().max(40).nullable().transform((value) => value || null);

const createBody = z.object({
	name,
	description: description.default(""),
	instructions: instructions.default(""),
	icon: icon.default(null),
});
const updateBody = z.object({ name: name.optional(), description: description.optional(), instructions: instructions.optional(), icon: icon.optional() });
const memberBody = z.object({ access: z.enum(["ask", "edit"]) });
const orgAccessBody = z.object({ orgAccess: z.enum(["none", "ask"]) });
// A repeated or odd query value is ignored, not refused.
const peopleQuery = z.object({ q: z.string().default("").catch("").transform((q) => q.slice(0, 200)) });

const notFound = (_: Workspaces.WorkspaceNotFound | Documents.DocumentNotFound, c: Context) => c.json({ error: "Not found" }, 404);
const refused = (error: Workspaces.WorkspaceRefused, c: Context) => c.json({ error: error.message }, 403);
const sharingErrors = { WorkspaceNotFound: notFound, WorkspaceRefused: refused } as const;
const documentErrors = { WorkspaceNotFound: notFound, WorkspaceRefused: refused, DocumentNotFound: notFound } as const;

export const workspacesApi = new Hono<Env>()
	// The sidebar's list. Also in the chat page's boot data (boot-page.ts).
	.get("/", (c) => route(c, Effect.map(workspaces((service) => service.list(actorOf(c).id)), (list) => c.json({ workspaces: list }))))

	.post("/", body(createBody), (c) =>
		route(c, Effect.map(workspaces((service) => service.create(actorOf(c), c.req.valid("json"))), (workspace) => c.json({ workspace }, 201))),
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

	// Sharing, one change at a time (Workspaces.ts). Each answers the workspace as the person sees it now.
	.put("/:id/members/:userId", body(memberBody), (c) =>
		route(c, Effect.map(workspaces((service) => service.setMember(actorOf(c), c.req.param("id"), c.req.param("userId"), c.req.valid("json").access)), (workspace) => c.json({ workspace })), {
			...sharingErrors,
			UnknownPerson: (error, c) => c.json({ error: error.message }, 400),
		}),
	)

	.delete("/:id/members/:userId", (c) =>
		route(c, Effect.map(workspaces((service) => service.removeMember(actorOf(c), c.req.param("id"), c.req.param("userId"))), (workspace) => c.json({ workspace })), sharingErrors),
	)

	// A team, at Can ask or Can edit: every member of the team has it while the team is active.
	.put("/:id/teams/:teamId", body(memberBody), (c) =>
		route(c, Effect.map(workspaces((service) => service.setTeam(actorOf(c), c.req.param("id"), c.req.param("teamId"), c.req.valid("json").access)), (workspace) => c.json({ workspace })), {
			...sharingErrors,
			TeamNotFound: (_, c) => c.json({ error: "Not found" }, 404),
		}),
	)

	.delete("/:id/teams/:teamId", (c) =>
		route(c, Effect.map(workspaces((service) => service.removeTeam(actorOf(c), c.req.param("id"), c.req.param("teamId"))), (workspace) => c.json({ workspace })), sharingErrors),
	)

	// General access: everyone in the organisation can ask ("ask"), or only the people added ("none").
	.put("/:id/access", body(orgAccessBody), (c) =>
		route(c, Effect.map(workspaces((service) => service.setOrgAccess(actorOf(c), c.req.param("id"), c.req.valid("json").orgAccess)), (workspace) => c.json({ workspace })), sharingErrors),
	)

	// The person's own pin, at the top of their list: anyone who can use the workspace. Nobody else sees it.
	.put("/:id/pin", (c) =>
		route(c, Effect.map(workspaces((service) => service.pin(actorOf(c).id, c.req.param("id"), true)), () => c.json({ pinned: true })), {
			WorkspaceNotFound: notFound,
		}),
	)

	.delete("/:id/pin", (c) =>
		route(c, Effect.map(workspaces((service) => service.pin(actorOf(c).id, c.req.param("id"), false)), () => c.json({ pinned: false })), {
			WorkspaceNotFound: notFound,
		}),
	)

	.delete("/:id", (c) =>
		route(c, Effect.map(workspaces((service) => service.remove(actorOf(c), c.req.param("id"))), () => c.json({ ok: true })), {
			WorkspaceNotFound: notFound,
			WorkspaceRefused: refused,
		}),
	)

	// A document: the form's `file`, read and indexed in the background. Answers at once, with the document "reading".
	// The upload is a form, read by the route: a form validator would turn "too large" (uploadLimit) into a 400.
	.post("/:id/documents", perPerson, uploadLimit, async (c) => {
		const form = await c.req.formData();
		const file = form.get("file");
		if (!(file instanceof File)) return c.json({ error: "No file in the upload." }, 400);
		return route(c, Effect.map(documents((service) => service.upload(actorOf(c), c.req.param("id"), file)), (document) => c.json({ document }, 201)), {
			WorkspaceNotFound: notFound,
			WorkspaceRefused: refused,
			DocumentRefused: (error, c) => c.json({ error: Documents.refusalText(file.name, error) }, 400),
		});
	})

	.delete("/:id/documents/:doc", (c) =>
		route(c, Effect.map(documents((service) => service.remove(actorOf(c), c.req.param("id"), c.req.param("doc"))), () => c.json({ ok: true })), documentErrors),
	)

	// The indexing log, for the Details view: people who can edit only.
	.get("/:id/documents/:doc/log", (c) =>
		route(c, Effect.map(documents((service) => service.log(actorOf(c), c.req.param("id"), c.req.param("doc"))), (log) => c.json(log)), documentErrors),
	)

	// The uploaded file, for the side viewer: anyone who can ask. Cached only to be checked again
	// (no-cache), so a person who loses the workspace can't open it from the browser's cache.
	.get("/:id/documents/:doc/file", (c) =>
		route(
			c,
			Effect.map(documents((service) => service.file(actorOf(c), c.req.param("id"), c.req.param("doc"))), (file) =>
				c.body(new Uint8Array(file.data), 200, { ...fileHeaders(file.name, file.mediaType), "Cache-Control": "private, no-cache" }),
			),
			documentErrors,
		),
	)

	// "Try again", for a document that failed.
	.post("/:id/documents/:doc/retry", (c) =>
		route(c, Effect.map(documents((service) => service.retry(actorOf(c), c.req.param("id"), c.req.param("doc"))), (document) => c.json({ document })), {
			...documentErrors,
			DocumentNotFailed: (error, c) => c.json({ error: error.message }, 409),
		}),
	);

/** /api/people?q=: the people picker of the Share dialog. Any signed-in person; at most 20, with id, name and email. */
export const peopleApi = new Hono<Env>().get("/", validate("query", peopleQuery), (c) =>
	route(c, Effect.map(Accounts.Accounts.use((accounts) => accounts.search(c.req.valid("query").q)), (people) => c.json({ people }))),
);
