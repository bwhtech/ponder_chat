import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { etag } from "hono/etag";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { adminApi } from "./admin/routes.ts";
import { connectorsApi, oauthCallback } from "./mcp/routes.ts";
import { displayName } from "./admin/people.ts";
import { roleOf } from "./admins.ts";
import { appOrigin, auth, type SignedInEnv } from "./auth.ts";
import { creditStatus } from "./credits.ts";
import { askForCredits } from "./extra-credits.ts";
import { listThreads, renameThread, sql } from "./db.ts";
import { loadFile, MAX_FILE_BYTES, saveFile } from "./files.ts";
import { memoryFor } from "./memory.ts";
import { memoryApi } from "./memory/routes.ts";
import { availableModels } from "./models.ts";
import { notifyAdmins } from "./notify.ts";
import { chatLimit, creditRequestLimit, limitPerPerson, searchLimit, uploadLimit as uploadRate, type RateLimit } from "./rate-limit.ts";
import { activeSkills } from "./skills.ts";
import { searchThreads } from "./thread-search.ts";
import { pythonReady } from "./startup.ts";
import { isFirstMessage, nameThread } from "./thread-title.ts";
import { threadResponse } from "./thread-cache.ts";
import { usageReport } from "./telemetry.ts";
import { deleteChat, followReply, startReply, stopReply, whenReplyFinished } from "./workflow/replies.ts";

/**
 * The HTTP API, served by Nitro (nitro.config.ts), which also compiles the chat workflow
 * ("use workflow", "use step") and serves the workflow's internal flow route. Start-up
 * work (migrations, the Postgres World's worker) is in server/plugins/startup.ts.
 */
type Env = SignedInEnv;
const app = new Hono<Env>();

// For the uptime checks: the server answers and its database does. 503 otherwise.
app.get("/health", async (c) => {
	try {
		await Promise.race([sql`select 1`, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))]);
		return c.text("ok");
	} catch {
		return c.text("database unavailable", 503);
	}
});

// The end of a connector's OAuth sign-in (mcp/routes.ts). It reads the session itself.
app.get("/oauth/mcp/callback", oauthCallback);

// Sign-in (auth.ts): magic links, sessions. Every other /api route needs a signed-in person.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.use("/api/*", async (c, next) => {
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.json({ error: "Sign in first." }, 401);
	c.set("user", session.user);
	await next();
});
const userOf = (c: Context<Env>) => c.get("user").id;
/** At most so many uses per person (rate-limit.ts). */
const perPerson = (limit: RateLimit, options?: { plain?: boolean }) => limitPerPerson(limit, (c: Context<Env>) => userOf(c), options);

// Who is signed in, their role (read from the database, not the cookie), and their credits for today.
app.get("/api/me", async (c) => {
	const { id, email, name } = c.get("user");
	const [role, credits] = await Promise.all([roleOf(id), creditStatus(id)]);
	return c.json({ user: { id, email, name, role }, credits });
});

// The admin pages' API (admin/routes.ts). Every route there needs the admin role.
app.route("/api/admin", adminApi);

// Connectors: the MCP servers each person connected (server/mcp/).
app.route("/api/connectors", connectorsApi);

// Whether the chat can run Python, for the attach button.
app.get("/api/features", async (c) => c.json({ python: await pythonReady }));

// The models a person can pick (only those with Zero Data Retention), and the one picked when they have not chosen.
app.get("/api/models", async (c) => c.json(await availableModels()));

// The skills that are on, for the $ menu: names and descriptions, not the instructions.
app.get("/api/skills", async (c) =>
	c.json({ skills: (await activeSkills()).map(({ name, description }) => ({ name, description })) }),
);

app.get("/api/credits", async (c) => c.json(await creditStatus(userOf(c))));

// Out of credits: ask the admins for more (extra-credits.ts). One request waits at a time.
app.post("/api/credits/request", perPerson(creditRequestLimit), async (c) => {
	const status = await creditStatus(userOf(c));
	if (status.request?.status === "pending") return c.json({ error: "You asked already. The admins have not answered yet." }, 409);
	if (status.remaining > 0) return c.json({ error: "You still have credits for today." }, 400);
	if (!(await askForCredits(userOf(c)))) return c.json({ error: "You asked already. The admins have not answered yet." }, 409);
	const { name, email } = c.get("user");
	await notifyAdmins(
		"Ponder Chat: credit request",
		`${displayName(name, email)} asked for more credits (${status.used >= 100 ? Math.round(status.used) : status.used} of ${status.limit} used today).`,
		`${appOrigin(c.req.raw.headers)}/admin/requests`,
	);
	return c.json(await creditStatus(userOf(c)));
});

// The list revalidates by its content and goes gzipped; one thread has its own cache (thread-cache.ts).
app.get("/api/threads", compress(), etag(), async (c) => c.json({ threads: await listThreads(userOf(c)) }));

// Search in the person's chats (thread-search.ts). Before /api/threads/:id, which would take "search" as an id.
app.get("/api/threads/search", perPerson(searchLimit), async (c) => c.json({ threads: await searchThreads(userOf(c), String(c.req.query("q") ?? "").slice(0, 200)) }));

app.patch("/api/threads/:id", async (c) => {
	const { title } = await c.req.json<{ title?: string }>();
	const renamed = await renameThread(c.req.param("id"), userOf(c), String(title ?? "").slice(0, 120));
	return renamed ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

// A reply still running stops first (workflow/replies.ts).
app.delete("/api/threads/:id", async (c) =>
	(await deleteChat(c.req.param("id"), userOf(c))) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404),
);

app.get("/api/threads/:id", (c) => threadResponse(c, c.req.param("id"), userOf(c)));

app.post("/api/chat", perPerson(chatLimit, { plain: true }), async (c) => {
	const body = await c.req.json<{ id: string; messages: UIMessage[]; model?: string }>();
	// A run with no messages fails before it writes, and its stream would never close.
	if (typeof body.id !== "string" || !Array.isArray(body.messages) || !body.messages.length) return c.text("Nothing to send.", 400);
	// The chat transport shows the response text as the error, so this one is plain text.
	const credits = await creditStatus(userOf(c));
	if (credits.remaining <= 0) return c.text(outOfCredits(credits.resetsAt), 402);
	const reply = await startReply({ threadId: body.id, owner: userOf(c), messages: body.messages, model: body.model });
	if (!reply) return c.json({ error: "Not found" }, 404);
	// A new thread gets a name from a cheap model while the reply is written (thread-title.ts).
	if (!reply.followed && isFirstMessage(body.messages)) void nameThread({ threadId: body.id, user: userOf(c) }, body.messages);
	return createUIMessageStreamResponse({ stream: reply.stream, headers: { "x-workflow-run-id": reply.runId } });
});

function outOfCredits(resetsAt: string) {
	const hours = Math.max(1, Math.ceil((new Date(resetsAt).getTime() - Date.now()) / 3_600_000));
	return `You have used today's credits. They refill in about ${hours} hour${hours === 1 ? "" : "s"}.`;
}

// A reply, from its start or from `startIndex` (the UI chunks the page already has).
// :id is the thread (a reloaded page) or the run (WorkflowChatTransport after a dropped
// connection). 204 when the thread has no run.
app.get("/api/chat/:id/stream", async (c) => {
	const startIndex = Number(c.req.query("startIndex") ?? 0);
	const reply = await followReply(c.req.param("id"), userOf(c), Number.isSafeInteger(startIndex) && startIndex > 0 ? startIndex : 0);
	if (!reply) return c.body(null, 204);
	return createUIMessageStreamResponse({ stream: reply.stream, headers: { "x-workflow-run-id": reply.runId } });
});

// Stop: closing the request does not end a run; this does.
app.post("/api/chat/:id/stop", async (c) => c.json({ stopped: await stopReply(c.req.param("id"), userOf(c)) }));

// Memory (server/memory/routes.ts): what Ponder remembers about the person, and the decisions behind it.
app.route("/api/memory", memoryApi);

// A chat's memory decisions. With ?wait=1, first waits for the reply to be saved and its memory save to end.
app.get("/api/threads/:id/memory", async (c) => {
	const threadId = c.req.param("id");
	const wait = Boolean(c.req.query("wait"));
	if (wait) await whenReplyFinished(threadId);
	return c.json({ saves: await memoryFor(userOf(c)).threadSaves(threadId, { settle: wait }) });
});

// Files attached in the chat. Each person sees only their own.
const uploadLimit = bodyLimit({
	maxSize: MAX_FILE_BYTES + 64 * 1024,
	onError: (c) => c.json({ error: "That file is larger than 10 MB." }, 413),
});

app.post("/api/files", perPerson(uploadRate), uploadLimit, async (c) => {
	const form = await c.req.formData();
	const file = form.get("file");
	if (!(file instanceof File)) return c.json({ error: "No file in the upload." }, 400);
	const result = await saveFile(userOf(c), file);
	return "error" in result ? c.json(result, 400) : c.json(result.file);
});

app.get("/api/files/:id", async (c) => {
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
});

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/csv", "text/tab-separated-values", "text/markdown", "application/json"]);

// Tokens and cost of a person's runs, optionally for one thread.
app.get("/api/usage", async (c) => c.json(await usageReport({ user: userOf(c), thread: c.req.query("thread") })));

// The admin pages are their own app (web/admin.html) with its own routes under /admin/.
const adminPage = serveStatic({ path: "./dist/admin.html" });
app.get("/admin", adminPage);
app.get("/admin/*", adminPage);

app.use("/*", serveStatic({ root: "./dist" }));

export default app;
