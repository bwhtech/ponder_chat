import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Limits on how often one person can do something, per signed-in person. Ponder runs as
 * one process, so counts are kept in memory; a restart clears them. Credits already cap
 * what replies cost; these stop a stuck script or a held-down key from flooding the
 * server, the email admins or the file store.
 *
 * The Hono middleware that answers 429 is in rate-limit.ts.
 */
type Window = { max: number; ms: number };

/** The counts of one limit. Plain code: the time of each use is given, so a test can choose it. */
export class RateLimit {
	private hits = new Map<string, number[]>();
	private readonly longest: number;

	constructor(private windows: Window[]) {
		this.longest = Math.max(...windows.map((window) => window.ms));
	}

	/** Counts one use at `now` (milliseconds). Seconds to wait when over a limit; 0 when it is allowed. */
	take(key: string, now: number): number {
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

/** Each limit and its windows. */
export const LIMITS = {
	/** Messages sent: a person types far slower; queued messages go one at a time. */
	chat: [
		{ max: 12, ms: MINUTE },
		{ max: 200, ms: HOUR },
	],
	upload: [
		{ max: 30, ms: 10 * MINUTE },
		{ max: 150, ms: 24 * HOUR },
	],
	/** Each request emails the admins. */
	creditRequest: [{ max: 3, ms: HOUR }],
	search: [{ max: 60, ms: MINUTE }],
	/** Connectors: each probe, add, sign-in and refresh reaches another server. */
	connector: [
		{ max: 30, ms: 10 * MINUTE },
		{ max: 200, ms: 24 * HOUR },
	],
} satisfies Record<string, Window[]>;

export type LimitName = keyof typeof LIMITS;

export class RateLimits extends Context.Service<
	RateLimits,
	{
		/** Counts one use of `limit` by `key`, now. Seconds to wait when over the limit; 0 when it is allowed. */
		readonly take: (limit: LimitName, key: string) => Effect.Effect<number>;
	}
>()("ponder/limits/RateLimits") {}

const make = Effect.sync(() => {
	const limits = Object.fromEntries(Object.entries(LIMITS).map(([name, windows]) => [name, new RateLimit(windows)])) as Record<LimitName, RateLimit>;
	// No span: it runs on every limited request, and only counts in memory.
	const take = (limit: LimitName, key: string) => Effect.map(Clock.currentTimeMillis, (now) => limits[limit].take(key, now));
	return RateLimits.of({ take });
});

export const layer = Layer.effect(RateLimits, make);
