import * as Effect from "effect/Effect";
import * as Threads from "../threads/Threads.ts";
import * as Tracing from "../tracing/Tracing.ts";
import * as ThreadRuns from "../workflow/runs.ts";
import { modelMessages } from "../workflow/thread-messages.ts";
import { runCompaction, type CompactionDeps, type CompactionState, type CompactRequest, type CompactResult } from "./compaction.ts";
import * as CompactionStore from "./store.ts";
import * as Summarizer from "./summarize.ts";

export type { CompactionState, CompactRequest, CompactResult };

/**
 * One compaction (compaction.ts), with the database and the summarizer. Run by the chat
 * workflow's compactStep, through runStep: a failure is thrown as the error itself, so
 * Workflow runs the step again, as before.
 *
 * `status` writes to the step's stream (steps.ts), a Promise API. Its rejection is a
 * defect, which runStep throws as the error itself.
 */
// The span's name and attributes are the ones it had before Effect: tracing.check.ts checks them.
export const compact = Effect.fn("compaction.run")(function* (request: CompactRequest, options: { lastAttempt: boolean; status: (state: CompactionState) => Promise<void> }) {
	// Counts and the outcome only: never the summary or the messages (tracing/privacy.ts).
	yield* Tracing.annotate({ "ponder.between_steps": request.mode === "turn", "ponder.last_attempt": options.lastAttempt });
	const threads = yield* Threads.Threads;
	const store = yield* CompactionStore.CompactionStore;
	const summarizer = yield* Summarizer.Summarizer;
	const runs = yield* ThreadRuns.ThreadRuns;
	const services = yield* Effect.context<Effect.Services<ReturnType<typeof modelMessages>>>();
	const deps: CompactionDeps<Summarizer.SummaryError> = {
		loadThread: threads.load,
		loadSummary: store.loadSummary,
		saveSummary: store.saveSummary,
		// A failure of these two is a defect, as it was: runStep throws it as itself, and Workflow runs the step again.
		superseded: (threadId, runId) => Effect.orDie(runs.superseded(threadId, runId)),
		writeSummary: summarizer.write,
		modelMessages: (thread, messageOptions) => Effect.orDie(Effect.provideContext(modelMessages(thread, messageOptions), services)),
		status: (state) => Effect.promise(() => options.status(state)),
		log: (message) => Effect.logError(message),
	};
	const result = yield* runCompaction(request, deps, options.lastAttempt);
	yield* Tracing.annotate({
		"ponder.outcome": result.kind,
		"ponder.tokens": result.kind === "unchanged" ? undefined : result.tokens,
		"ponder.limit": result.kind === "over-limit" ? result.limit : undefined,
	});
	return result;
});
