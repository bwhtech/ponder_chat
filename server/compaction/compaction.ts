import type { ModelMessage, UIMessage } from "ai";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { isSqlError } from "effect/sql/SqlError";
import { sqlMessage } from "../runtime/Database.ts";
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
 * (compact.ts), so the checks run this without them. Each is an Effect, with its own
 * failures in `E`.
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
	/** The <workspace_excerpts> block (workspaces/prompt.ts): like `recalled`, with the latest message, never summarized. */
	excerpts?: string;
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

export type CompactionDeps<E> = {
	loadThread(threadId: string): Effect.Effect<UIMessage[], E>;
	loadSummary(threadId: string, thread: UIMessage[]): Effect.Effect<Option.Option<Summary>, E>;
	saveSummary(threadId: string, thread: UIMessage[], summary: Summary, model: string): Effect.Effect<void, E>;
	/** True when another run replaced this one, or it was stopped. */
	superseded(threadId: string, runId: string): Effect.Effect<boolean, E>;
	writeSummary(input: { run: { threadId: string; user: string }; chatModel: string; previous: string | undefined; messages: UIMessage[]; ratio: number }): Effect.Effect<{ text: string; model: string }, E>;
	modelMessages(
		thread: UIMessage[],
		options: { owner: string; modelId: string; recalled: string; skills: ActiveSkill[]; connectors: string; excerpts?: string; keepReasoningOf?: string },
	): Effect.Effect<ModelMessage[], E>;
	status(state: CompactionState): Effect.Effect<void, E>;
	log(message: string): Effect.Effect<void>;
};

/** After a compaction the text should be at most this share of the trigger, so the next one is not soon. */
const FIT_SHARE = 0.75;
/**
 * Less text than this share of the trigger to fold is not worth a summary. It keeps a
 * chat that is over the trigger because of its files from summarizing on every reply.
 */
const MIN_FOLD_SHARE = 0.1;

/**
 * Runs one compaction. `lastAttempt` is the step's last try: a summary that fails then
 * leaves the old messages out instead of failing the step.
 */
export function runCompaction<E>(request: CompactRequest, deps: CompactionDeps<E>, lastAttempt: boolean): Effect.Effect<CompactResult, E> {
	const budget = budgetFor(request.window);
	const { threadId, owner, runId, modelId, mode, ratio } = request;

	/** The call's estimate: these messages, the instructions and tools, and the current turn between steps. */
	const total = (messages: ModelMessage[]) => addEstimates(estimate(messages), { text: request.envelope, media: 0 }, request.turn ?? { text: 0, media: 0 });

	const messagesWith = (thread: UIMessage[], summary: Summary) => {
		const { recalled, skills, connectors, excerpts, keepReasoningOf } = request;
		if (mode === "start") return deps.modelMessages(withSummary(thread, summary), { owner, modelId, recalled, skills, connectors, excerpts, keepReasoningOf });
		// Between steps, only the summary message is new: the current turn is already in the prompt, memory and connector notes included.
		const message = summaryMessage(thread.slice(0, summary.covers), thread.slice(summary.covers), summary);
		return deps.modelMessages([message], { owner, modelId, recalled: "", skills, connectors: "" });
	};

	/**
	 * The messages with the saved summary. Between steps only when it ends at the current
	 * turn: the result replaces everything before the turn, so it must cover all of it.
	 */
	const reuse = (thread: UIMessage[], previous: Summary, turn: number) => {
		if (mode === "turn" && previous.covers !== turn) return Effect.succeed(undefined);
		return Effect.map(messagesWith(thread, previous), (messages) => ({ messages, tokens: countTokens(total(messages), ratio) }));
	};

	const done = (thread: UIMessage[], previous: Summary, reused: { messages: ModelMessage[]; tokens: number }) =>
		Effect.as(deps.status({ state: "done", through: thread[previous.covers - 1]?.id }), { kind: "compacted" as const, ...reused });

	const worthFolding = (messages: UIMessage[]) => ratio * estimate(messages).text >= budget.trigger * MIN_FOLD_SHARE;

	/**
	 * The first option that fits: keep the files, then name them only, then keep only the
	 * current turn. Text decides: the estimate for images and PDFs is a guess from their
	 * size, so it never drops a file or refuses a message on its own.
	 */
	const fit = Effect.fnUntraced(function* (thread: UIMessage[], textFor: (covers: number) => string, covers: number, turn: number) {
		const options = [
			{ covers, keepFiles: true },
			{ covers, keepFiles: false },
			...(covers < turn ? [{ covers: turn, keepFiles: false }] : []),
		];
		let text = 0;
		for (const [index, option] of options.entries()) {
			const summary: Summary = { ...option, text: textFor(option.covers) };
			const messages = yield* messagesWith(thread, summary);
			const estimated = total(messages);
			text = Math.ceil(ratio * estimated.text);
			const last = index === options.length - 1;
			if (text <= (last ? budget.limit : budget.trigger * FIT_SHARE)) {
				return { kind: "fits" as const, summary, messages, tokens: countTokens(estimated, ratio) };
			}
		}
		return { kind: "over-limit" as const, tokens: text, limit: budget.limit };
	});

	return Effect.gen(function* () {
		const thread = yield* deps.loadThread(threadId);
		const previous = Option.getOrUndefined(yield* deps.loadSummary(threadId, thread));
		const from = previous?.covers ?? 0;
		const turn = currentTurnStart(thread);
		// The saved summary already brings the call under the trigger: a step retried after its
		// save lands here, and so does a run whose messages were loaded before another run's save.
		const reused = previous && (yield* reuse(thread, previous, turn));
		if (previous && reused && reused.tokens <= budget.trigger) return yield* done(thread, previous, reused);
		const covers = mode === "turn" ? (turn > from ? turn : undefined) : planCovers(thread, from, budget.tail);
		// Nothing new worth folding: the saved summary, if any, is still the best there is.
		if (covers === undefined || !worthFolding(thread.slice(from, covers))) return previous && reused ? yield* done(thread, previous, reused) : { kind: "unchanged" as const };
		if (yield* deps.superseded(threadId, runId)) return { kind: "unchanged" as const };

		yield* deps.status({ state: "running" });
		const messages = thread.slice(from, turn);
		// Any failure of the summary, on the last attempt, leaves the old messages out; before it, the step tries again.
		const written = yield* deps.writeSummary({ run: { threadId, user: owner }, chatModel: modelId, previous: previous?.text, messages, ratio }).pipe(
			Effect.catchCause((cause) => {
				if (!lastAttempt || Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
				return Effect.as(deps.log(`reply degraded: summary (thread ${threadId}): ${problem(Cause.squash(cause))}`), undefined);
			}),
		);
		const textFor = (end: number) => written?.text ?? [previous?.text, leftOutNote(end - from)].filter(Boolean).join("\n\n");
		const fitted = yield* fit(thread, textFor, covers, turn);
		if (fitted.kind === "over-limit") {
			yield* deps.status({ state: "failed" });
			return fitted;
		}
		// The summary read up to the current turn, so its fingerprint covers that much.
		const summary = { ...fitted.summary, reads: turn };
		if (written && !(yield* deps.superseded(threadId, runId))) yield* deps.saveSummary(threadId, thread, summary, written.model);
		yield* deps.status({ state: written ? "done" : "failed", through: thread[summary.covers - 1]?.id });
		return { kind: written ? ("compacted" as const) : ("left-out" as const), messages: fitted.messages, tokens: fitted.tokens };
	});
}

/** What a failed summary says in the log: Postgres's own words for a database error, else the error's message. */
function problem(error: unknown) {
	if (isSqlError(error)) return sqlMessage(error);
	return error instanceof Error ? error.message : String(error);
}
