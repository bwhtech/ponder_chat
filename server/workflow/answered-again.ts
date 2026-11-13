import { isToolUIPart, type UIMessage, type UIMessageChunk } from "ai";
import type { Continued } from "./runs.ts";

/**
 * An approval answered again after a run already carried it out: a second tab that still
 * shows the question, or the same request sent twice. The page sends its whole thread,
 * so the answer alone can't tell; the saved thread can (replies.ts).
 */

/**
 * True when the saved thread already went on from the message the request carries on:
 * the saved message has parts the request's does not, or a call the request answers
 * already has its result there. A run that carries on the message adds a step, and each
 * call it runs gets its result in place.
 *
 * Not true for the next question in the same message, which a run asked after the
 * person's first answer: the page then sends the message as it was saved, with the same
 * parts, and that call has no result yet.
 */
export function carriedOut(saved: UIMessage | undefined, asked: UIMessage, continued: Continued): boolean {
	if (!saved) return false;
	if (saved.parts.length > continued.baseParts) return true;
	const results = settledResults(saved);
	return answeredCalls(asked).some((toolCallId) => results.has(toolCallId));
}

/**
 * The results of the calls the page answered, from the saved message, as UI chunks. The
 * page puts them in place of its answers: it shows what happened, and does not send the
 * answers again, as it would for answers that still wait for a result.
 */
export function settledChunks(saved: UIMessage, asked: UIMessage): UIMessageChunk[] {
	const results = settledResults(saved);
	const chunks = answeredCalls(asked).flatMap((toolCallId) => {
		const result = results.get(toolCallId);
		return result ? [result] : [];
	});
	return [{ type: "start", messageId: asked.id }, { type: "start-step" }, ...chunks, { type: "finish-step" }, { type: "finish" }];
}

/** The calls in the page's message that the person answered. */
function answeredCalls(asked: UIMessage): string[] {
	return asked.parts.flatMap((part) => (isToolUIPart(part) && part.state === "approval-responded" ? [part.toolCallId] : []));
}

/** Each call of the saved message that has a result, as the chunk that gives the page that result. */
function settledResults(saved: UIMessage): Map<string, UIMessageChunk> {
	const results = new Map<string, UIMessageChunk>();
	for (const part of saved.parts) {
		if (!isToolUIPart(part)) continue;
		const { toolCallId } = part;
		if (part.state === "output-available") results.set(toolCallId, { type: "tool-output-available", toolCallId, output: part.output });
		if (part.state === "output-error") results.set(toolCallId, { type: "tool-output-error", toolCallId, errorText: part.errorText });
		if (part.state === "output-denied") results.set(toolCallId, { type: "tool-output-denied", toolCallId });
	}
	return results;
}
