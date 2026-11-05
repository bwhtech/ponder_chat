import type { Context, Next } from "hono";

/**
 * Limits on how often one person can do something, per signed-in person. Ponder runs as
 * one process, so counts are kept in memory; a restart clears them. Credits already cap
 * what replies cost; these stop a stuck script or a held-down key from flooding the
 * server, the email admins or the file store.
 */
type Window = { max: number; ms: number };

export class RateLimit {
	private hits = new Map<string, number[]>();
	private readonly longest: number;

	constructor(private windows: Window[]) {
		this.longest = Math.max(...windows.map((window) => window.ms));
	}

	/** Counts one use. Seconds to wait when over a limit; 0 when it is allowed. */
	take(key: string, now = Date.now()): number {
		const recent = (this.hits.get(key) ?? []).filter((time) => now - time < this.longest);
		const wait = Math.max(0, ...this.windows.map((window) => this.waitFor(window, recent, now)));
		if (!wait) recent.push(now);
		this.hits.set(key, recent);
		if (this.hits.size > 10_000) this.prune(now);
		return wait;
	}

	private waitFor({ max, ms }: Window, recent: number[], now: number) {
		const inWindow = recent.filter((time) => now - time < ms);
		return inWindow.length < max ? 0 : Math.ceil((inWindow[inWindow.length - max] + ms - now) / 1000);
	}

	private prune(now: number) {
		for (const [key, times] of this.hits) if (times.every((time) => now - time >= this.longest)) this.hits.delete(key);
	}
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Messages sent: a person types far slower; queued messages go one at a time. */
export const chatLimit = new RateLimit([
	{ max: 12, ms: MINUTE },
	{ max: 200, ms: HOUR },
]);
export const uploadLimit = new RateLimit([
	{ max: 30, ms: 10 * MINUTE },
	{ max: 150, ms: 24 * HOUR },
]);
/** Each request emails the admins. */
export const creditRequestLimit = new RateLimit([{ max: 3, ms: HOUR }]);
export const searchLimit = new RateLimit([{ max: 60, ms: MINUTE }]);

/**
 * Hono middleware: 429 when the person is over the limit. `plain` answers in plain text,
 * for the chat transport, which shows the response text as the error.
 */
export function limitPerPerson<C extends Context>(limit: RateLimit, who: (c: C) => string, { plain = false } = {}) {
	return async (c: C, next: Next) => {
		const wait = limit.take(who(c));
		if (!wait) return next();
		const message = `Too many requests. Try again in ${wait < 60 ? plural(wait, "second") : plural(Math.ceil(wait / 60), "minute")}.`;
		c.header("Retry-After", String(wait));
		return plain ? c.text(message, 429) : c.json({ error: message }, 429);
	};
}

function plural(count: number, unit: string) {
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}
