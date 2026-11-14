import type { ModelMessage, ToolResultPart, UIMessage } from "ai";
import { isAuto } from "../../shared/auto-model.ts";

/**
 * What the model reads of a thread, shaped to keep each call small and its start the
 * same from one call to the next, so providers can cache it (cache.ts).
 */

/** A tool result older than the kept turns, longer than this, is cut to its start. */
const TRIM_OVER_CHARS = 3_000;
const KEEP_CHARS = 1_000;
/** The current turn and the one before keep their tool results whole, for follow-ups such as "what else did that page say?". */
export const WHOLE_TURNS = 2;

/**
 * Cuts long tool results (Python output, fetched pages, search results) from turns
 * older than the last WHOLE_TURNS. A result is trimmed once and stays trimmed, so the
 * history before the kept turns does not change between calls, and providers can
 * cache it (cache.ts).
 */
export function trimOldToolResults(messages: ModelMessage[]): ModelMessage[] {
	const keptFrom = turnsStart(messages.map((message) => message.role), WHOLE_TURNS);
	return messages.map((message, index) => {
		if (index >= keptFrom || message.role !== "tool") return message;
		return { ...message, content: message.content.map((part) => (part.type === "tool-result" ? trimResult(part) : part)) };
	});
}

/**
 * Drops the reasoning of replies that another model wrote. Its signature is of no use to
 * this model, and OpenRouter sends a call that carries it to the provider that signed it:
 * after a switch from Claude, DeepSeek went only to Google, so when Google failed there
 * was no other provider to try. A reply with no model in its metadata keeps its reasoning.
 * Under Auto every reply drops it: Auto may pick a model other than the one that wrote it.
 */
export function dropOtherModelsReasoning(messages: UIMessage[], modelId: string): UIMessage[] {
	return messages.map((message) => {
		const writer = (message.metadata as { model?: unknown } | undefined)?.model;
		if (message.role !== "assistant" || typeof writer !== "string" || (writer === modelId && !isAuto(modelId))) return message;
		if (!message.parts.some((part) => part.type === "reasoning")) return message;
		return { ...message, parts: message.parts.filter((part) => part.type !== "reasoning") };
	});
}

/**
 * Adds what memory recalled to the person's latest message. It changes with every
 * message, so it stays out of the instructions: the instructions and the history before
 * this message are then the same as on the last call, and providers can cache them.
 */
export function addRecalledMemory(messages: ModelMessage[], recalled: string): ModelMessage[] {
	const index = lastUserIndex(messages);
	const message = messages[index];
	if (!recalled || message?.role !== "user") return messages;
	const note = { type: "text" as const, text: `<memory>\n${recalled}\n</memory>` };
	const content = typeof message.content === "string" ? [note, { type: "text" as const, text: message.content }] : [note, ...message.content];
	return messages.map((each, i) => (i === index ? { ...message, content } : each));
}

/** A long result cut to its start, with a note. Also used for the earlier steps of a reply that grew too long (context-guard.ts). */
export function trimResult(part: ToolResultPart): ToolResultPart {
	const text = resultText(part.output);
	if (text === undefined || text.length <= TRIM_OVER_CHARS) return part;
	const note = `[Trimmed: this ${part.toolName} result is from an earlier turn and had ${text.length} characters. Run the tool again if you need the rest.]`;
	return { ...part, output: { type: "text", value: `${text.slice(0, KEEP_CHARS)}…\n${note}` } };
}

function resultText(output: ToolResultPart["output"]) {
	if (output.type === "text" || output.type === "error-text") return output.value;
	if (output.type === "json" || output.type === "error-json") return JSON.stringify(output.value);
	return undefined;
}

/** Where the person's last `turns` turns start: the index of that message of theirs, or 0 when there are fewer turns. */
export function turnsStart(roles: string[], turns: number) {
	let start = roles.length;
	for (let i = 0; i < turns; i++) {
		// lastIndexOf with a negative start would search from the end.
		start = start > 0 ? roles.lastIndexOf("user", start - 1) : -1;
		if (start === -1) return 0;
	}
	return start;
}

function lastUserIndex(messages: ModelMessage[]) {
	return messages.map((message) => message.role).lastIndexOf("user");
}
