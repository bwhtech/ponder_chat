import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

type Options = {
	/** The message to answer with, in place of the schema's own. */
	error?: string;
	/** Plain text, for the chat transport, which shows the response text as the error. */
	plain?: boolean;
};

/**
 * Hono middleware: checks the request's JSON body or query with a zod schema before the
 * route runs, which reads the result with c.req.valid(). A refusal is a 400 with
 * `{ error }`, the shape web/api.ts reads. The schema is also the type of the input in
 * the typed client (AppType in app.ts).
 *
 * The refusal is thrown, not returned: a returned one would add a 400 to the type of
 * every route's answer. Hono answers an HTTPException with its response.
 */
export function validate<Target extends "json" | "query", Schema extends z.ZodType>(target: Target, schema: Schema, options: Options = {}) {
	const check = zValidator(target, schema, (result, c) => {
		if (!result.success) refuse(c, options.error ?? result.error.issues[0]?.message ?? "That request is not valid.", options.plain);
	});
	if (target === "query") return check;
	const checkJson: typeof check = async (c, next) => {
		// Not JSON is a 400 that says so, as `{ error }`: the validator's own refusal is plain text.
		// Without a JSON Content-Type the validator would check `{}` in place of the body, so
		// a rename, for example, would clear the title. Hono keeps the body it read, so the
		// validator reads it again for free.
		if (!JSON_TYPE.test(c.req.header("Content-Type") ?? "")) refuse(c, "Send the request body as JSON.", options.plain);
		if (!(await c.req.json().then(() => true, () => false))) refuse(c, "The request body is not valid JSON.", options.plain);
		return check(c, next);
	};
	return checkJson;
}

/** What Hono's validator reads as JSON. */
const JSON_TYPE = /^application\/([a-z-\.]+\+)?json(;\s*[a-zA-Z0-9\-]+=([^;]+))*$/i;

function refuse(c: Context, error: string, plain = false): never {
	throw new HTTPException(400, { res: plain ? c.text(error, 400) : c.json({ error }, 400) });
}
