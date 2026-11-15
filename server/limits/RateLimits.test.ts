/**
 * The per-person rate limits, with the TestClock: the windows, the wait in seconds, and
 * other people unaffected.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as RateLimits from "./RateLimits.ts";

const take = (limit: RateLimits.LimitName, key: string) => RateLimits.RateLimits.use((limits) => limits.take(limit, key));

describe("RateLimits", () => {
	it.effect("allows 12 messages a minute, then says how long to wait", () =>
		Effect.gen(function* () {
			for (let i = 0; i < 12; i++) {
				assert.strictEqual(yield* take("chat", "ana"), 0);
				yield* TestClock.adjust("1 second");
			}
			// The first message was 12 seconds ago: it leaves the window in 48 seconds.
			assert.strictEqual(yield* take("chat", "ana"), 48);
			// Someone else, and another limit, are not affected.
			assert.strictEqual(yield* take("chat", "ben"), 0);
			assert.strictEqual(yield* take("search", "ana"), 0);
			yield* TestClock.adjust("48 seconds");
			assert.strictEqual(yield* take("chat", "ana"), 0);
		}).pipe(Effect.provide(RateLimits.layer)),
	);

	it.effect("a refused use is not counted", () =>
		Effect.gen(function* () {
			for (let i = 0; i < 3; i++) assert.strictEqual(yield* take("creditRequest", "ana"), 0);
			assert.strictEqual(yield* take("creditRequest", "ana"), 3600);
			yield* TestClock.adjust("30 minutes");
			assert.strictEqual(yield* take("creditRequest", "ana"), 1800);
			yield* TestClock.adjust("30 minutes");
			// All three left the hour together; the refusals in between did not count.
			for (let i = 0; i < 3; i++) assert.strictEqual(yield* take("creditRequest", "ana"), 0);
		}).pipe(Effect.provide(RateLimits.layer)),
	);

	it.effect("the longer window holds when the short one is free", () =>
		Effect.gen(function* () {
			// 200 messages an hour: 12 a minute for 17 minutes reaches it.
			let allowed = 0;
			for (let minute = 0; minute < 17; minute++) {
				for (let i = 0; i < 12; i++) if ((yield* take("chat", "ana")) === 0) allowed++;
				yield* TestClock.adjust("1 minute");
			}
			assert.strictEqual(allowed, 200);
			// The first of the hour's 200 was 17 minutes ago: 43 minutes to wait.
			assert.strictEqual(yield* take("chat", "ana"), 43 * 60);
		}).pipe(Effect.provide(RateLimits.layer)),
	);

	it("keeps the plain windows (RateLimit) as before", () => {
		const limit = new RateLimits.RateLimit([{ max: 2, ms: 60_000 }]);
		assert.strictEqual(limit.take("ana", 0), 0);
		assert.strictEqual(limit.take("ana", 1_000), 0);
		assert.strictEqual(limit.take("ana", 2_000), 58);
		assert.strictEqual(limit.take("ben", 2_000), 0);
		assert.strictEqual(limit.take("ana", 60_001), 0);
	});
});
