/**
 * Polls one chain at a time: each poll is set after the answer to the last one. `stop` and
 * a new `start` end the chain at once, also while an answer is on its way, so that answer
 * can neither set another poll nor start a second chain beside the new one.
 */
export class Poller {
	private chain = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * `poll` gives the wait before the next poll, or null to stop. `current()` says whether
	 * its chain still runs: an answer that comes after a stop is not for the page any more.
	 */
	constructor(private readonly poll: (current: () => boolean) => Promise<number | null>) {}

	start(delay: number) {
		this.stop();
		this.schedule(this.chain, delay);
	}

	stop() {
		this.chain++;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private schedule(chain: number, delay: number) {
		const current = () => chain === this.chain;
		this.timer = setTimeout(async () => {
			const next = await this.poll(current);
			if (current() && next !== null) this.schedule(chain, next);
		}, delay);
	}
}
