import { loadThread } from "../db.ts";
import { modelMessages } from "../workflow/thread-messages.ts";
import { span } from "../tracing/span.ts";
import { superseded } from "../workflow/runs.ts";
import { Compaction, type CompactionState, type CompactRequest, type CompactResult } from "./compaction.ts";
import { loadSummary, saveSummary } from "./store.ts";
import { writeSummary } from "./summarize.ts";

export type { CompactionState, CompactRequest, CompactResult };

/** One compaction (compaction.ts), with the database and the summarizer. Run by the chat workflow's compactStep. */
export async function compact(request: CompactRequest, options: { lastAttempt: boolean; status: (state: CompactionState) => Promise<void> }) {
	const deps = { loadThread, loadSummary, saveSummary, superseded, writeSummary, modelMessages, status: options.status, log: console.error };
	// Counts and the outcome only: never the summary or the messages (tracing/privacy.ts).
	return span("compaction.run", { "ponder.between_steps": request.mode === "turn", "ponder.last_attempt": options.lastAttempt }, async (active) => {
		const result = await new Compaction(request, deps).run(options.lastAttempt);
		active.setAttribute("ponder.outcome", result.kind);
		if (result.kind !== "unchanged") active.setAttribute("ponder.tokens", result.tokens);
		if (result.kind === "over-limit") active.setAttribute("ponder.limit", result.limit);
		return result;
	});
}
