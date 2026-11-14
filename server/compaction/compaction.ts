import type { ModelMessage, UIMessage } from "ai";
import type { ActiveSkill } from "../skills.ts";
import { leftOutNote } from "./prompt.ts";
import { currentTurnStart, planCovers, summaryMessage, withSummary, type Summary } from "./summary.ts";
import { addEstimates, budgetFor, countTokens, estimate, type Estimate } from "./tokens.ts";

/**
 * One compaction, adapted from eve's compaction engine.ts. The summarizer reads the
 * previous summary and the messages after it, up to the current turn. The tail stays
 * word for word, and the first option of the ladder that fits wins.
 *
 * Unlike eve, a summary that can't be written does not fail the reply. On the step's
 * last attempt, the covered messages are left out with a note instead, nothing is
 * saved, and the next reply tries again.
 *
 * The database, the summarizer and the message builder come in as `CompactionDeps`
 * (compact.ts), so the checks run this without them.
 */
export type CompactRequest = {
	threadId: string;
	owner: string;
	/** The workflow run asking. A run that was stopped or replaced saves nothing. */
	runId: string;
	modelId: string;
	recalled: string;
	/** The <connectors> note: like `recalled`, it goes with the latest message, never into the summary. */
	connectors: string;
	skills: ActiveSkill[];
	/** A reply that keeps its reasoning (workflow/context.ts), as the messages without a summary would. */
	keepReasoningOf?: string;
	ratio: number;
	window: number | null;
	/** The estimated text tokens of the instructions and the tools. */
	envelope: number;
	/**
	 * "start": before the reply's first model call; the result is all its messages.
	 * "turn": between the steps of a reply; everything before the current turn is
	 * summarized, and the result is the summary message only.
	 */
	mode: "start" | "turn";
	/** For "turn": the estimate of the current turn, as the prompt holds it now. */
	turn?: Estimate;
};

export type CompactResult =
	| { kind: "compacted" | "left-out"; messages: ModelMessage[]; tokens: number }
	| { kind: "unchanged" }
	| { kind: "over-limit"; tokens: number; limit: number };

export type CompactionState = { state: "running" | "done" | "failed"; through?: string };

export type CompactionDeps = {
	loadThread(threadId: string): Promise<UIMessage[]>;
	loadSummary(threadId: string, thread: UIMessage[]): Promise<Summary | undefined>;
	saveSummary(threadId: string, thread: UIMessage[], summary: Summary, model: string): Promise<void>;
	/** True when another run replaced this one, or it was stopped. */
	superseded(threadId: string, runId: string): Promise<boolean>;
	writeSummary(input: { run: { threadId: string; user: string }; chatModel: string; previous: string | undefined; messages: UIMessage[]; ratio: number }): Promise<{ text: string; model: string }>;
	modelMessages(
		thread: UIMessage[],
		options: { owner: string; modelId: string; recalled: string; skills: ActiveSkill[]; connectors: string; keepReasoningOf?: string },
	): Promise<ModelMessage[]>;
	status(state: CompactionState): Promise<void>;
	log(message: string): void;
};

/** After a compaction the text should be at most this share of the trigger, so the next one is not soon. */
const FIT_SHARE = 0.75;
/**
 * Less text than this share of the trigger to fold is not worth a summary. It keeps a
 * chat that is over the trigger because of its files from summarizing on every reply.
 */
const MIN_FOLD_SHARE = 0.1;

export class Compaction {
	private budget;

	constructor(
		private request: CompactRequest,
		private deps: CompactionDeps,
	) {
		this.budget = budgetFor(request.window);
	}

	async run(lastAttempt: boolean): Promise<CompactResult> {
		const { threadId, owner, runId, modelId, mode, ratio } = this.request;
		const thread = await this.deps.loadThread(threadId);
		const previous = await this.deps.loadSummary(threadId, thread);
		const from = previous?.covers ?? 0;
		const turn = currentTurnStart(thread);
		// The saved summary already brings the call under the trigger: a step retried after its
		// save lands here, and so does a run whose messages were loaded before another run's save.
		const reused = previous && (await this.reuse(thread, previous, turn));
		if (reused && reused.tokens <= this.budget.trigger) return this.done(thread, previous, reused);
		const covers = mode === "turn" ? (turn > from ? turn : undefined) : planCovers(thread, from, this.budget.tail);
		// Nothing new worth folding: the saved summary, if any, is still the best there is.
		if (covers === undefined || !this.worthFolding(thread.slice(from, covers))) return reused ? this.done(thread, previous, reused) : { kind: "unchanged" };
		if (await this.deps.superseded(threadId, runId)) return { kind: "unchanged" };

		await this.deps.status({ state: "running" });
		const messages = thread.slice(from, turn);
		const written = await this.deps.writeSummary({ run: { threadId, user: owner }, chatModel: modelId, previous: previous?.text, messages, ratio }).catch((error) => {
			if (!lastAttempt) throw error;
			this.deps.log(`reply degraded: summary (thread ${threadId}): ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		});
		const textFor = (end: number) => written?.text ?? [previous?.text, leftOutNote(end - from)].filter(Boolean).join("\n\n");
		const fitted = await this.fit(thread, textFor, covers, turn);
		if (fitted.kind === "over-limit") {
			await this.deps.status({ state: "failed" });
			return fitted;
		}
		// The summary read up to the current turn, so its fingerprint covers that much.
		const summary = { ...fitted.summary, reads: turn };
		if (written && !(await this.deps.superseded(threadId, runId))) await this.deps.saveSummary(threadId, thread, summary, written.model);
		await this.deps.status({ state: written ? "done" : "failed", through: thread[summary.covers - 1]?.id });
		return { kind: written ? "compacted" : "left-out", messages: fitted.messages, tokens: fitted.tokens };
	}

	/**
	 * The messages with the saved summary. Between steps only when it ends at the current
	 * turn: the result replaces everything before the turn, so it must cover all of it.
	 */
	private async reuse(thread: UIMessage[], previous: Summary, turn: number) {
		if (this.request.mode === "turn" && previous.covers !== turn) return undefined;
		const messages = await this.messagesWith(thread, previous);
		return { messages, tokens: countTokens(this.total(messages), this.request.ratio) };
	}

	private async done(thread: UIMessage[], previous: Summary, reused: { messages: ModelMessage[]; tokens: number }): Promise<CompactResult> {
		await this.deps.status({ state: "done", through: thread[previous.covers - 1]?.id });
		return { kind: "compacted", ...reused };
	}

	private worthFolding(messages: UIMessage[]) {
		return this.request.ratio * estimate(messages).text >= this.budget.trigger * MIN_FOLD_SHARE;
	}

	/**
	 * The first option that fits: keep the files, then name them only, then keep only the
	 * current turn. Text decides: the estimate for images and PDFs is a guess from their
	 * size, so it never drops a file or refuses a message on its own.
	 */
	private async fit(thread: UIMessage[], textFor: (covers: number) => string, covers: number, turn: number) {
		const options = [
			{ covers, keepFiles: true },
			{ covers, keepFiles: false },
			...(covers < turn ? [{ covers: turn, keepFiles: false }] : []),
		];
		let text = 0;
		for (const [index, option] of options.entries()) {
			const summary: Summary = { ...option, text: textFor(option.covers) };
			const messages = await this.messagesWith(thread, summary);
			const total = this.total(messages);
			text = Math.ceil(this.request.ratio * total.text);
			const last = index === options.length - 1;
			if (text <= (last ? this.budget.limit : this.budget.trigger * FIT_SHARE)) {
				return { kind: "fits" as const, summary, messages, tokens: countTokens(total, this.request.ratio) };
			}
		}
		return { kind: "over-limit" as const, tokens: text, limit: this.budget.limit };
	}

	/** The call's estimate: these messages, the instructions and tools, and the current turn between steps. */
	private total(messages: ModelMessage[]) {
		return addEstimates(estimate(messages), { text: this.request.envelope, media: 0 }, this.request.turn ?? { text: 0, media: 0 });
	}

	private async messagesWith(thread: UIMessage[], summary: Summary) {
		const { owner, modelId, recalled, skills, connectors, keepReasoningOf, mode } = this.request;
		if (mode === "start") return this.deps.modelMessages(withSummary(thread, summary), { owner, modelId, recalled, skills, connectors, keepReasoningOf });
		// Between steps, only the summary message is new: the current turn is already in the prompt, memory and connector notes included.
		const message = summaryMessage(thread.slice(0, summary.covers), thread.slice(summary.covers), summary);
		return this.deps.modelMessages([message], { owner, modelId, recalled: "", skills, connectors: "" });
	}
}
