import { type Context, Hono } from "hono";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { z } from "zod";
import type { SignedInEnv } from "../auth.ts";
import * as Memory from "../memory.ts";
import { route } from "../runtime/route.ts";
import { validate } from "../validate.ts";

const userOf = (c: Context<SignedInEnv>) => c.get("user").id;
const notFound = (c: Context, error = "Not found") => c.json({ error }, 404);

const memoryText = z.object({ text: z.string().trim().min(1).transform((text) => text.slice(0, 1000)) });

/** /api/memory: what Ponder remembers about the signed-in person, and the decisions behind it (memory.ts). */
export const memoryApi = new Hono<SignedInEnv>()
	.get("/", (c) => route(c, Effect.map(Memory.Memory.use((memory) => memory.overview(userOf(c))), (overview) => c.json(overview))))

	.patch("/:id", validate("json", memoryText, { error: "A memory needs some text." }), (c) => {
		const { text } = c.req.valid("json");
		return route(
			c,
			Effect.map(Memory.Memory.use((memory) => memory.update(userOf(c), c.req.param("id"), text)), (updated) => (updated ? c.json({ ok: true }) : notFound(c))),
		);
	})

	.delete("/:id", (c) =>
		route(c, Effect.map(Memory.Memory.use((memory) => memory.forget(userOf(c), c.req.param("id"))), (forgotten) => (forgotten ? c.json({ ok: true }) : notFound(c)))),
	)

	.post("/saves/:id/undo", (c) => {
		const saveId = Number(c.req.param("id"));
		if (!Number.isSafeInteger(saveId)) return notFound(c);
		return route(
			c,
			Effect.map(
				Memory.Memory.use((memory) => memory.undo(userOf(c), saveId)),
				Option.match({ onNone: () => notFound(c, "Not found, or undone already."), onSome: (operations) => c.json({ ok: true, operations }) }),
			),
		);
	});
