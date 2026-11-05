import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { etag } from "hono/etag";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { getRun, start } from "workflow/api";
import { auth, type SignedIn } from "./auth.ts";
import { creditStatus } from "./credits.ts";
import { deleteThread, listThreads, renameThread, saveThread, sql, threadOwner } from "./db.ts";
import { loadFile, MAX_FILE_BYTES, saveFile } from "./files.ts";
import { DEFAULT_MODEL, MODELS, pickModel } from "./models.ts";
import { forgetPythonState } from "./python/state.ts";
import { pythonReady } from "./startup.ts";
import { isFirstMessage, nameThread } from "./thread-title.ts";
import { forgetThread, threadResponse } from "./thread-cache.ts";
import { usageReport } from "./telemetry.ts";
import { chatTurn } from "./workflow/chat.ts";
import { replyStream, saveReply } from "./workflow/reply.ts";
import { activeRun, latestRun, setActiveRun } from "./workflow/runs.ts";

/**
 * The HTTP API, served by Nitro (nitro.config.ts), which also compiles the chat workflow
 * ("use workflow", "use step") and serves the workflow's internal flow route. Start-up
 * work (migrations, the Postgres World's worker) is in server/plugins/startup.ts.
 */
const MAX_STEPS = Number(process.env.CHAT_MAX_STEPS ?? 10);

type Env = { Variables: { user: SignedIn } };
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

// Sign-in (auth.ts): magic links, sessions. Every other /api route needs a signed-in person.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.use("/api/*", async (c, next) => {
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.json({ error: "Sign in first." }, 401);
	c.set("user", session.user);
	await next();
});
const userOf = (c: Context<Env>) => c.get("user").id;
/** A thread id the person may use: theirs, or not taken yet. */
const mayUseThread = async (c: Context<Env>, id: string) => ((await threadOwner(id)) ?? userOf(c)) === userOf(c);

// Who is signed in, and their credits for today.
app.get("/api/me", async (c) => {
	const { id, email, name } = c.get("user");
	return c.json({ user: { id, email, name }, credits: await creditStatus(id) });
});

// Whether the chat can run Python, for the attach button.
app.get("/api/features", async (c) => c.json({ python: await pythonReady }));

// The models a person can pick, and the one picked when they have not chosen.
app.get("/api/models", (c) => c.json({ models: MODELS, defaultModel: DEFAULT_MODEL }));

app.get("/api/credits", async (c) => c.json(await creditStatus(userOf(c))));

// The list revalidates by its content and goes gzipped; one thread has its own cache (thread-cache.ts).
app.get("/api/threads", compress(), etag(), async (c) => c.json({ threads: await listThreads(userOf(c)) }));

app.patch("/api/threads/:id", async (c) => {
	const { title } = await c.req.json<{ title?: string }>();
	const renamed = await renameThread(c.req.param("id"), userOf(c), String(title ?? "").slice(0, 120));
	return renamed ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

app.delete("/api/threads/:id", async (c) => {
	const deleted = await deleteThread(c.req.param("id"), userOf(c));
	if (deleted) {
		forgetThread(c.req.param("id"));
		await forgetPythonState(c.req.param("id"), userOf(c));
	}
	return deleted ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

app.get("/api/threads/:id", (c) => threadResponse(c, c.req.param("id"), userOf(c)));

app.post("/api/chat", async (c) => {
	const body = await c.req.json<{ id: string; messages: UIMessage[]; model?: string }>();
	if (!(await mayUseThread(c, body.id))) return c.json({ error: "Not found" }, 404);
	// The chat transport shows the response text as the error, so this one is plain text.
	const credits = await creditStatus(userOf(c));
	if (credits.remaining <= 0) return c.text(outOfCredits(credits.resetsAt), 402);

	// A reply still running in this thread (Steer, another tab) stops, and keeps what it wrote.
	const previous = await activeRun(body.id);
	if (previous) await cancelRun(body.id, userOf(c), previous);

	const model = pickModel(body.model);
	const run = { threadId: body.id, user: userOf(c) };
	// The run reads the thread from the database, so it is saved first.
	await saveThread(body.id, userOf(c), body.messages);
	const started = await start(chatTurn, [
		{
			threadId: body.id,
			owner: userOf(c),
			model: { id: model.id, name: model.name },
			python: await pythonReady,
			today: new Date().toDateString(),
			maxSteps: MAX_STEPS,
		},
	]);
	await setActiveRun(body.id, started.runId, model.id);
	// A new thread gets a name from a cheap model while the reply is written (thread-title.ts).
	if (isFirstMessage(body.messages)) void nameThread(run, body.messages);

	// The run goes on if this request closes; the page reconnects with GET /api/chat/:id/stream.
	return createUIMessageStreamResponse({ stream: await replyStream(started.runId, model.id), headers: { "x-workflow-run-id": started.runId } });
});

/** Cancels a run and saves what it wrote so far. */
async function cancelRun(threadId: string, owner: string, run: { runId: string; model: string }) {
	await getRun(run.runId).cancel({ cancelReason: "Stopped by the person, or replaced by a newer message." }).catch(() => undefined);
	// The step in flight writes on for a moment after a cancel, and the stream is never
	// closed, so the saved reply is what the run had written when it was stopped.
	await saveReply(threadId, owner, run.runId, run.model, { untilTail: true });
}

function outOfCredits(resetsAt: string) {
	const hours = Math.max(1, Math.ceil((new Date(resetsAt).getTime() - Date.now()) / 3_600_000));
	return `You have used today's credits. They refill in about ${hours} hour${hours === 1 ? "" : "s"}.`;
}

// A reply, from its start or from `startIndex` (the UI chunks the page already has).
// :id is the thread (a reloaded page) or the run (WorkflowChatTransport after a dropped
// connection). A finished run replays to its end; 204 when the thread has no run.
app.get("/api/chat/:id/stream", async (c) => {
	const run = await latestRun(c.req.param("id"));
	if (!run || !(await mayUseThread(c, run.threadId))) return c.body(null, 204);
	const startIndex = Number(c.req.query("startIndex") ?? 0);
	const uiStartIndex = Number.isSafeInteger(startIndex) && startIndex > 0 ? startIndex : 0;
	const stream = await replyStream(run.runId, run.model, { uiStartIndex, untilTail: run.cancelled });
	return createUIMessageStreamResponse({ stream, headers: { "x-workflow-run-id": run.runId } });
});

// Stop: closing the request does not end a run; this does.
app.post("/api/chat/:id/stop", async (c) => {
	if (!(await mayUseThread(c, c.req.param("id")))) return c.json({ stopped: false });
	const run = await activeRun(c.req.param("id"));
	if (run) await cancelRun(c.req.param("id"), userOf(c), run);
	return c.json({ stopped: Boolean(run) });
});

// Files attached in the chat. Each person sees only their own.
const uploadLimit = bodyLimit({
	maxSize: MAX_FILE_BYTES + 64 * 1024,
	onError: (c) => c.json({ error: "That file is larger than 10 MB." }, 413),
});

app.post("/api/files", uploadLimit, async (c) => {
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

app.use("/*", serveStatic({ root: "./dist" }));

export default app;
