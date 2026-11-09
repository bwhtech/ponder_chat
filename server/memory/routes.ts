import { type Context, Hono } from "hono";
import type { SignedInEnv } from "../auth.ts";
import { memoryFor } from "../memory.ts";

/** /api/memory: what Ponder remembers about the signed-in person, and the decisions behind it (memory.ts). */
export const memoryApi = new Hono<SignedInEnv>();

const mine = (c: Context<SignedInEnv>) => memoryFor(c.get("user").id);
const notFound = (c: Context, error = "Not found") => c.json({ error }, 404);

memoryApi.get("/", async (c) => c.json(await mine(c).overview()));

memoryApi.patch("/:id", async (c) => {
	const text = String((await c.req.json<{ text?: string }>()).text ?? "").trim().slice(0, 1000);
	if (!text) return c.json({ error: "A memory needs some text." }, 400);
	return (await mine(c).update(c.req.param("id"), text)) ? c.json({ ok: true }) : notFound(c);
});

memoryApi.delete("/:id", async (c) => ((await mine(c).forget(c.req.param("id"))) ? c.json({ ok: true }) : notFound(c)));

memoryApi.post("/saves/:id/undo", async (c) => {
	const saveId = Number(c.req.param("id"));
	if (!Number.isSafeInteger(saveId)) return notFound(c);
	const undone = await mine(c).undo(saveId);
	return undone ? c.json({ ok: true, operations: undone }) : notFound(c, "Not found, or undone already.");
});
