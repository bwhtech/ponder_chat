import type { ModelMessage, UIMessage } from "ai";
import { loadThread } from "../db.ts";
import type { ActiveSkill } from "../skills.ts";
import { modelMessages } from "../workflow/thread-messages.ts";
import { leftOutNote } from "./prompt.ts";
import { loadSummary, saveSummary } from "./store.ts";
import { currentTurnStart, planCovers, summaryMessage, withSummary, type Summary } from "./summary.ts";
import { writeSummary } from "./summarize.ts";
import { budgetFor, estimateTokens } from "./tokens.ts";

/**
 * One compaction, inside the chat workflow's compactStep. Adapted from eve's compaction
 * engine.ts: the summarizer reads the previous summary and everything after it, the
 * tail stays word for word, and the first option of the ladder that fits wins.
 *
 * Unlike eve, a summary that can't be written does not fail the reply. On the step's
 * last attempt, the covered messages are left out with a note instead, nothing is
 * saved, and the next reply tries again.
 */
export type CompactRequest = {
	threadId: string;
	owner: string;
	modelId: string;
	recalled: string;
	/** The <connectors> note: like `recalled`, it goes with the latest message, never into the summary. */
	connectors: string;
	skills: ActiveSkill[];
	ratio: number;
	window: number | null;
	/** The estimated tokens of the instructions and the tools. */
	envelope: number;
	/**
	 * "start": before the reply's first model call; the result is all its messages.
	 * "turn": between the steps of a reply; everything before the current turn is
	 * summarized, and the result is the summary message only.
	 */
	mode: "start" | "turn";
	/** For "turn": the estimated tokens of the current turn, as the prompt holds it now. */
	turnTokens?: number;
};

export type CompactResult =
	| { kind: "compacted" | "left-out"; messages: ModelMessage[]; tokens: number }
	| { kind: "unchanged" }
	| { kind: "over-limit"; tokens: number; limit: number };

export type CompactionState = { state: "running" | "done" | "failed"; through?: string };

/** After a compaction the call should be at most this share of the trigger, so the next one is not soon. */
const FIT_SHARE = 0.75;

export async function compact(request: CompactRequest, options: { lastAttempt: boolean; status: (state: CompactionState) => Promise<void> }) {
	return new Compaction(request, options.status).run(options.lastAttempt);
}

class Compaction {
	private budget;

	constructor(
		private request: CompactRequest,
		private status: (state: CompactionState) => Promise<void>,
	) {
		this.budget = budgetFor(request.window);
	}

	async run(lastAttempt: boolean): Promise<CompactResult> {
		const { threadId, owner, modelId, mode } = this.request;
		const thread = await loadThread(threadId);
		const previous = await loadSummary(threadId, thread);
		const from = previous?.covers ?? 0;
		const turn = currentTurnStart(thread);
		const covers = mode === "turn" ? (turn > from ? turn : undefined) : planCovers(thread, from, this.budget.tail);
		if (covers === undefined) return { kind: "unchanged" };

		await this.status({ state: "running" });
		const written = await writeSummary({ run: { threadId, user: owner }, chatModel: modelId, previous: previous?.text, messages: thread.slice(from) }).catch((error) => {
			if (!lastAttempt) throw error;
			console.error(`reply degraded: summary (thread ${threadId}): ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		});
		const text = written?.text ?? [previous?.text, leftOutNote(covers - from)].filter(Boolean).join("\n\n");
		const fitted = await this.fit(thread, text, covers);
		if (fitted.kind === "over-limit") {
			await this.status({ state: "failed" });
			return fitted;
		}
		const through = thread[fitted.summary.covers - 1]?.id;
		if (written) await saveSummary(threadId, thread, fitted.summary, written.model);
		await this.status({ state: written ? "done" : "failed", through });
		return { kind: written ? "compacted" : "left-out", messages: fitted.messages, tokens: fitted.tokens };
	}

	/** The first option that fits: keep the files, then name them only, then keep only the current turn. */
	private async fit(thread: UIMessage[], text: string, covers: number) {
		const turn = currentTurnStart(thread);
		const options: Summary[] = [
			{ text, covers, keepFiles: true },
			{ text, covers, keepFiles: false },
			...(covers < turn ? [{ text, covers: turn, keepFiles: false }] : []),
		];
		let tokens = 0;
		for (const [index, summary] of options.entries()) {
			const messages = await this.messagesWith(thread, summary);
			tokens = Math.ceil(this.request.ratio * (estimateTokens(messages) + this.request.envelope + (this.request.turnTokens ?? 0)));
			const last = index === options.length - 1;
			if (tokens <= (last ? this.budget.limit : this.budget.trigger * FIT_SHARE)) return { kind: "fits" as const, summary, messages, tokens };
		}
		return { kind: "over-limit" as const, tokens, limit: this.budget.limit };
	}

	private async messagesWith(thread: UIMessage[], summary: Summary) {
		const { owner, modelId, recalled, skills, connectors, mode } = this.request;
		if (mode === "start") return modelMessages(withSummary(thread, summary), { owner, modelId, recalled, skills, connectors });
		// Between steps, only the summary message is new: the current turn is already in the prompt, memory and connector notes included.
		const message = summaryMessage(thread.slice(0, summary.covers), thread.slice(summary.covers), summary);
		return modelMessages([message], { owner, modelId, recalled: "", skills, connectors: "" });
	}
}
