import { isToolUIPart, type UIMessage, type UIMessageChunk } from "ai";
import { THREAD_CHANGED } from "../../shared/replies.ts";

/**
 * Approvals answered again: a second tab that still shows the question, the same request
 * sent twice, an old card after Stop or after Retry replaced the reply. The page sends
 * its whole thread, so its answers alone can't tell. What decides (replies.ts):
 *
 * - the saved thread, where each answered question must still wait for an answer;
 * - approval_uses (approval-uses.ts), the durable record that an answer was used.
 */

/** An answer the page sends: the person approved or denied the call, and no result came yet. */
export type Answer = { approvalId: string; toolCallId: string; approved: boolean };

/** The answers in the message the request carries on. */
export function answersIn(asked: UIMessage): Answer[] {
	return asked.parts.flatMap((part) =>
		isToolUIPart(part) && part.state === "approval-responded" ? [{ approvalId: part.approval.id, toolCallId: part.toolCallId, approved: part.approval.approved }] : [],
	);
}

/**
 * True when each answered question still waits for an answer in the saved message. False
 * when the saved message is gone (Retry replaced it), or a question there was answered
 * already, or has a result.
 */
export function stillAsked(saved: UIMessage | undefined, answers: Answer[]): boolean {
	if (!saved) return false;
	const waiting = new Set(saved.parts.flatMap((part) => (isToolUIPart(part) && part.state === "approval-requested" ? [part.approval.id] : [])));
	return answers.every((answer) => waiting.has(answer.approvalId));
}

/** What the page reads for an approved call whose outcome Ponder can't tell: it was sent, and stopped or lost before its result. */
export const UNCERTAIN =
	"This approval was already used, in another tab or an earlier reply, so the call did not run again. It may or may not have taken effect: check before you ask for it again.";

/**
 * The saved message with an outcome in place of each answer that has none (each of
 * `answers`, or every one): UNCERTAIN for an approved call, the denial for a denied one.
 * Undefined when nothing changes. For a run that stopped or failed after it sent the
 * call, and before its result.
 */
export function withUncertainOutcomes(saved: UIMessage, answers?: Answer[]): UIMessage | undefined {
	const answered = answers && new Set(answers.map((answer) => answer.approvalId));
	let changed = false;
	const parts = saved.parts.map((part) => {
		if (!isToolUIPart(part) || part.state !== "approval-responded" || (answered && !answered.has(part.approval.id))) return part;
		changed = true;
		return part.approval.approved ? { ...part, state: "output-error" as const, errorText: UNCERTAIN } : { ...part, state: "output-denied" as const };
	});
	return changed ? ({ ...saved, parts } as UIMessage) : undefined;
}

/**
 * The thread as the model reads it: an answer with no result before the last message was
 * cut short (Stop, a crash) or never carried out, so it reads as an outcome. The model
 * needs a result for each call it made, and the call never runs again. Only the last
 * message's answers are the ones a run carries out now.
 */
export function openAnswersSettled(thread: UIMessage[]): UIMessage[] {
	return thread.map((message, index) => (index === thread.length - 1 || message.role !== "assistant" ? message : (withUncertainOutcomes(message) ?? message)));
}

/**
 * Each answered call's outcome, as UI chunks, in place of the page's answers: the saved
 * result when there is one, the denial for a denied call, and otherwise UNCERTAIN. The
 * page shows them and does not send its answers again, as it would for answers that
 * still wait for a result. THREAD_CHANGED then makes it load the thread as it is saved,
 * with what came after.
 */
export function settledChunks(saved: UIMessage | undefined, asked: UIMessage): UIMessageChunk[] {
	const results = settledResults(saved);
	const chunks = answersIn(asked).map(({ toolCallId, approved }): UIMessageChunk => {
		const result = results.get(toolCallId);
		if (result) return result;
		return approved ? { type: "tool-output-error", toolCallId, errorText: UNCERTAIN } : { type: "tool-output-denied", toolCallId };
	});
	return [
		{ type: "start", messageId: asked.id },
		{ type: THREAD_CHANGED, data: {}, transient: true },
		{ type: "start-step" },
		...chunks,
		{ type: "finish-step" },
		{ type: "finish" },
	];
}

/** Each call of the saved message that has a result, as the chunk that gives the page that result. */
function settledResults(saved: UIMessage | undefined): Map<string, UIMessageChunk> {
	const results = new Map<string, UIMessageChunk>();
	for (const part of saved?.parts ?? []) {
		if (!isToolUIPart(part)) continue;
		const { toolCallId } = part;
		if (part.state === "output-available") results.set(toolCallId, { type: "tool-output-available", toolCallId, output: part.output });
		if (part.state === "output-error") results.set(toolCallId, { type: "tool-output-error", toolCallId, errorText: part.errorText });
		if (part.state === "output-denied") results.set(toolCallId, { type: "tool-output-denied", toolCallId });
	}
	return results;
}
