import { type Context, Hono } from "hono";
import { z } from "zod";
import type { SignedInEnv } from "../auth.ts";
import { memoryFor } from "../memory.ts";
import { validate } from "../validate.ts";

const mine = (c: Context<SignedInEnv>) => memoryFor(c.get("user").id);
const notFound = (c: Context, error = "Not found") => c.json({ error }, 404);

const memoryText = z.object({ text: z.string().trim().min(1).transform((text) => text.slice(0, 1000)) });

/** /api/memory: what Ponder remembers about the signed-in person, and the decisions behind it (memory.ts). */
export const memoryApi = new Hono<SignedInEnv>()
	.get("/", async (c) => c.json(await mine(c).overview()))

	.patch("/:id", validate("json", memoryText, { error: "A memory needs some text." }), async (c) => {
		const { text } = c.req.valid("json");
		return (await mine(c).update(c.req.param("id"), text)) ? c.json({ ok: true }) : notFound(c);
	})

	.delete("/:id", async (c) => ((await mine(c).forget(c.req.param("id"))) ? c.json({ ok: true }) : notFound(c)))

	.post("/saves/:id/undo", async (c) => {
		const saveId = Number(c.req.param("id"));
		if (!Number.isSafeInteger(saveId)) return notFound(c);
		const undone = await mine(c).undo(saveId);
		return undone ? c.json({ ok: true, operations: undone }) : notFound(c, "Not found, or undone already.");
	});
