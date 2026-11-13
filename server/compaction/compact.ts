import { loadThread } from "../db.ts";
import { modelMessages } from "../workflow/thread-messages.ts";
import { superseded } from "../workflow/runs.ts";
import { Compaction, type CompactionState, type CompactRequest, type CompactResult } from "./compaction.ts";
import { loadSummary, saveSummary } from "./store.ts";
import { writeSummary } from "./summarize.ts";

export type { CompactionState, CompactRequest, CompactResult };

/** One compaction (compaction.ts), with the database and the summarizer. Run by the chat workflow's compactStep. */
export async function compact(request: CompactRequest, options: { lastAttempt: boolean; status: (state: CompactionState) => Promise<void> }) {
	const deps = { loadThread, loadSummary, saveSummary, superseded, writeSummary, modelMessages, status: options.status, log: console.error };
	return new Compaction(request, deps).run(options.lastAttempt);
}
