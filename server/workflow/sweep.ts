import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { SqlError } from "effect/sql/SqlError";
import * as PonderConfig from "../config.ts";
import * as ModelCalls from "../telemetry/ModelCalls.ts";
import * as Documents from "../workspaces/documents/Documents.ts";
import * as Replies from "./replies.ts";

/**
 * Work that waits for no reply, done by the one server that runs the workflow worker
 * (startup.ts), at start-up and then every PONDER_SWEEP_SECONDS. Four jobs, each in a fiber
 * of its own, so a slow OpenRouter never keeps a thread looking busy:
 * - finish the runs that ended without saving their reply (replies.ts);
 * - get the cost of model calls that were cut short (telemetry/ModelCalls.ts);
 * - start again the indexing of workspace documents left Reading with no run (Documents.ts);
 * - delete the bucket objects of deleted documents that a crash or a failure left (Documents.ts).
 * A job still running when its time comes again is not started twice: the next run waits
 * for it. A failure is logged, and the job runs again at its next time.
 *
 * Runs until it is interrupted: startup.ts forks it, and on SIGTERM interrupts it before
 * the database closes.
 */
export const sweeps = Effect.gen(function* () {
	const { sweepSeconds } = yield* PonderConfig.PonderConfig;
	const jobs: ReadonlyArray<{ name: string; run: Effect.Effect<unknown, SqlError, Replies.Replies | ModelCalls.ModelCalls | Documents.Documents> }> = [
		{ name: "finish ended runs", run: Replies.Replies.use((replies) => replies.finishEndedRuns) },
		{ name: "get the cost of model calls", run: ModelCalls.ModelCalls.use((calls) => calls.fillCosts) },
		{ name: "restart stalled document indexing", run: Documents.Documents.use((documents) => documents.restartStalled) },
		{ name: "delete the files of deleted documents", run: Documents.Documents.use((documents) => documents.removeLeftObjects) },
	];
	yield* Effect.forEach(
		jobs,
		(job) =>
			job.run.pipe(
				Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError(`sweep: could not ${job.name}:`, Cause.squash(cause)))),
				Effect.repeat(Schedule.fixed(Duration.seconds(sweepSeconds))),
			),
		{ concurrency: "unbounded", discard: true },
	);
});
