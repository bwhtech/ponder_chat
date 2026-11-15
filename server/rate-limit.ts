import type { Context, Next } from "hono";
import * as RateLimits from "./limits/RateLimits.ts";
import { route } from "./runtime/route.ts";

/**
 * Hono middleware: 429 when the person is over the limit (limits/RateLimits.ts). `plain`
 * answers in plain text, for the chat transport, which shows the response text as the error.
 */
export function limitPerPerson<C extends Context>(limit: RateLimits.LimitName, who: (c: C) => string, { plain = false } = {}) {
	return async (c: C, next: Next) => {
		const wait = await route(c, RateLimits.RateLimits.use((limits) => limits.take(limit, who(c))));
		if (!wait) return next();
		const message = `Too many requests. Try again in ${wait < 60 ? plural(wait, "second") : plural(Math.ceil(wait / 60), "minute")}.`;
		c.header("Retry-After", String(wait));
		return plain ? c.text(message, 429) : c.json({ error: message }, 429);
	};
}

function plural(count: number, unit: string) {
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}
