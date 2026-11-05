import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { etag } from "hono/etag";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { getRun, start } from "workflow/api";
import { adminApi } from "./admin/routes.ts";
import { displayName } from "./admin/people.ts";
import { roleOf } from "./admins.ts";
import { appOrigin, auth, type SignedIn } from "./auth.ts";
import { creditStatus } from "./credits.ts";
import { askForCredits } from "./extra-credits.ts";
import { deleteThread, listThreads, renameThread, saveThread, sql, threadOwner } from "./db.ts";
import { loadFile, MAX_FILE_BYTES, saveFile } from "./files.ts";
import { memory, memoryEnabled, memoryScope, memoryStore, readExtractPrompt } from "./memory.ts";
import { availableModels, pickModel } from "./models.ts";
import { notifyAdmins } from "./notify.ts";
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

// Who is signed in, their role (read from the database, not the cookie), and their credits for today.
app.get("/api/me", async (c) => {
	const { id, email, name } = c.get("user");
	const [role, credits] = await Promise.all([roleOf(id), creditStatus(id)]);
	return c.json({ user: { id, email, name, role }, credits });
});

// The admin pages' API (admin/routes.ts). Every route there needs the admin role.
app.route("/api/admin", adminApi);

// Whether the chat can run Python, for the attach button.
app.get("/api/features", async (c) => c.json({ python: await pythonReady }));

// The models a person can pick (only those with Zero Data Retention), and the one picked when they have not chosen.
app.get("/api/models", async (c) => c.json(await availableModels()));

app.get("/api/credits", async (c) => c.json(await creditStatus(userOf(c))));

// Out of credits: ask the admins for more (extra-credits.ts). One request waits at a time.
app.post("/api/credits/request", async (c) => {
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

	const model = await pickModel(body.model);
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

// Memory (server/memory.ts): what Ponder remembers about the person, and the decisions behind it.
const scopeOf = (c: Context<Env>, threadId = "") => memoryScope({ threadId, user: userOf(c) });

app.get("/api/memory", async (c) =>
	c.json({
		enabled: memoryEnabled,
		adapter: memoryStore.name,
		memories: await memoryStore.list(scopeOf(c)),
		saves: await memoryStore.saves(scopeOf(c), { limit: 30 }),
		prompt: await readExtractPrompt(),
	}),
);

app.patch("/api/memory/:id", async (c) => {
	const text = String((await c.req.json<{ text?: string }>()).text ?? "").trim().slice(0, 1000);
	if (!text) return c.json({ error: "A memory needs some text." }, 400);
	return (await memoryStore.update(scopeOf(c), c.req.param("id"), text)) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

app.delete("/api/memory/:id", async (c) =>
	(await memoryStore.forget(scopeOf(c), c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404),
);

app.post("/api/memory/saves/:id/undo", async (c) => {
	const saveId = Number(c.req.param("id"));
	if (!Number.isSafeInteger(saveId)) return c.json({ error: "Not found" }, 404);
	const undone = await memoryStore.undo(scopeOf(c), saveId);
	return undone ? c.json({ ok: true, operations: undone }) : c.json({ error: "Not found, or undone already." }, 404);
});

// A chat's memory decisions. With ?wait=1, first waits for the reply to be saved and its memory save to end.
app.get("/api/threads/:id/memory", async (c) => {
	const threadId = c.req.param("id");
	if (c.req.query("wait")) {
		await replyFinished(threadId);
		await memory.settled(threadId);
	}
	return c.json({ saves: await memoryStore.saves(scopeOf(c, threadId), { threadId }) });
});

/** The page sees the stream end a moment before the run's last step saves the reply and starts the memory save. */
async function replyFinished(threadId: string, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while ((await activeRun(threadId)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
}

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

// The admin pages are their own app (web/admin.html) with its own routes under /admin/.
const adminPage = serveStatic({ path: "./dist/admin.html" });
app.get("/admin", adminPage);
app.get("/admin/*", adminPage);

app.use("/*", serveStatic({ root: "./dist" }));

export default app;
