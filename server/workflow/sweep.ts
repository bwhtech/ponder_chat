import { runPromise } from "../runtime/runtime.ts";
import * as ModelCalls from "../telemetry/ModelCalls.ts";
import { finishEndedRuns } from "./replies.ts";

/**
 * Work that waits for no reply, done by the one server that runs the workflow worker
 * (startup.ts), at start-up and then every SWEEP_MS. Two jobs, each on its own timer, so
 * a slow OpenRouter never keeps a thread looking busy:
 * - finish the runs that ended without saving their reply (replies.ts);
 * - get the cost of model calls that were cut short (telemetry/ModelCalls.ts).
 * A job still running when its time comes again is not started twice.
 */
const SWEEP_MS = Math.max(1, Number(process.env.PONDER_SWEEP_SECONDS) || 60) * 1000;
const JOBS = [
	{ name: "finish ended runs", run: finishEndedRuns },
	{ name: "get the cost of model calls", run: () => runPromise(ModelCalls.ModelCalls.use((calls) => calls.fillCosts)) },
];
const timers: ReturnType<typeof setInterval>[] = [];

export function startSweeps() {
	for (const job of JOBS) {
		let running = false;
		const sweep = async () => {
			if (running) return;
			running = true;
			try {
				await job.run();
			} catch (error) {
				console.error(`sweep: could not ${job.name}:`, error);
			} finally {
				running = false;
			}
		};
		void sweep();
		const timer = setInterval(() => void sweep(), SWEEP_MS);
		timer.unref();
		timers.push(timer);
	}
}

/** On SIGTERM, before the database closes (startup.ts). A job in progress ends on its own. */
export function stopSweeps() {
	for (const timer of timers.splice(0)) clearInterval(timer);
}
