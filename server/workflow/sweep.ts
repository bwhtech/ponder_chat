import { fillModelCallCosts } from "../telemetry/model-calls.ts";
import { finishEndedRuns } from "./replies.ts";

/**
 * Work that waits for no reply, done at start-up and then every SWEEP_MS, by the one
 * server that runs the workflow worker (startup.ts):
 * - finish the runs that ended without saving their reply (replies.ts);
 * - get the cost of model calls that were cut short (telemetry/model-calls.ts).
 */
const SWEEP_MS = Math.max(1, Number(process.env.PONDER_SWEEP_SECONDS) || 60) * 1000;
let sweeping = false;
let timer: ReturnType<typeof setInterval> | undefined;

export function startSweeps() {
	void sweep();
	timer = setInterval(() => void sweep(), SWEEP_MS);
	timer.unref();
}

/** On SIGTERM, before the database closes (startup.ts). A sweep in progress ends on its own. */
export function stopSweeps() {
	clearInterval(timer);
	timer = undefined;
}

async function sweep() {
	if (sweeping) return;
	sweeping = true;
	try {
		await finishEndedRuns().catch((error) => console.error("sweep: could not finish ended runs:", error));
		await fillModelCallCosts().catch((error) => console.error("sweep: could not get the cost of model calls:", error));
	} finally {
		sweeping = false;
	}
}
