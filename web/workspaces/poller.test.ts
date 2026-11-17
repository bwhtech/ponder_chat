/**
 * The web's polls (poller.ts) with fake timers: one chain at a time, and none after a stop,
 * also when an answer was on its way.
 */
import { afterEach, assert, beforeEach, describe, it, vi } from "vitest";
import { Poller } from "./poller.ts";

/** A poll whose answers the test gives, one at a time. */
function polls(next: number | null = 1000) {
	const pending: Array<() => void> = [];
	let started = 0;
	const poller = new Poller(async () => {
		started++;
		await new Promise<void>((resolve) => pending.push(resolve));
		return next;
	});
	const answer = async () => {
		pending.shift()?.();
		await vi.advanceTimersByTimeAsync(0);
	};
	return { poller, answer, started: () => started, inFlight: () => pending.length };
}

describe("Poller", () => {
	beforeEach(() => void vi.useFakeTimers());
	afterEach(() => void vi.useRealTimers());

	it("polls again after each answer, with the wait it gives", async () => {
		const { poller, answer, started } = polls(1000);
		poller.start(0);
		await vi.advanceTimersByTimeAsync(0);
		assert.strictEqual(started(), 1);
		await vi.advanceTimersByTimeAsync(5000);
		assert.strictEqual(started(), 1, "no poll while one waits for its answer");
		await answer();
		await vi.advanceTimersByTimeAsync(999);
		assert.strictEqual(started(), 1);
		await vi.advanceTimersByTimeAsync(1);
		assert.strictEqual(started(), 2);
		poller.stop();
	});

	it("stops when the poll says so", async () => {
		const { poller, answer, started } = polls(null);
		poller.start(0);
		await vi.advanceTimersByTimeAsync(0);
		await answer();
		await vi.advanceTimersByTimeAsync(10_000);
		assert.strictEqual(started(), 1);
	});

	it("sets no poll after a stop, also when an answer was on its way", async () => {
		const { poller, answer, started } = polls(1000);
		poller.start(0);
		await vi.advanceTimersByTimeAsync(0);
		poller.stop();
		await answer();
		await vi.advanceTimersByTimeAsync(10_000);
		assert.strictEqual(started(), 1);
	});

	it("keeps one chain when it starts again while an answer is on its way", async () => {
		const { poller, answer, started, inFlight } = polls(1000);
		poller.start(0);
		await vi.advanceTimersByTimeAsync(0);
		poller.start(2000);
		await answer();
		await vi.advanceTimersByTimeAsync(2000);
		assert.strictEqual(started(), 2, "the new chain's first poll");
		for (let round = 0; round < 5; round++) {
			assert.strictEqual(inFlight(), 1, `round ${round}: one poll at a time`);
			await answer();
			await vi.advanceTimersByTimeAsync(1000);
		}
		assert.strictEqual(started(), 7);
		poller.stop();
	});

	it("tells a poll whether its chain still runs, so a late answer is not used", async () => {
		let current: () => boolean = () => true;
		let release = () => {};
		const poller = new Poller(async (isCurrent) => {
			current = isCurrent;
			await new Promise<void>((resolve) => (release = resolve));
			return null;
		});
		poller.start(0);
		await vi.advanceTimersByTimeAsync(0);
		assert.isTrue(current());
		poller.stop();
		release();
		assert.isFalse(current());
	});
});
