import { isDeepEqualData, type ModelMessage } from "ai";
import { CONNECTOR_CALL } from "../../shared/connectors.ts";

/**
 * Connectors in the thread the model reads (steps.ts, loadModelMessages).
 */

/**
 * Adds the <connectors> note (mcp/catalog-note.ts) to the person's latest message. It
 * changes when connectors change, so it stays out of the instructions, as memory's note
 * does (context.ts addRecalledMemory).
 */
export function addConnectorNote(messages: ModelMessage[], note: string): ModelMessage[] {
	const index = messages.map((message) => message.role).lastIndexOf("user");
	const message = messages[index];
	if (!note || message?.role !== "user") return messages;
	const part = { type: "text" as const, text: note };
	const content = typeof message.content === "string" ? [part, { type: "text" as const, text: message.content }] : [part, ...message.content];
	return messages.map((each, i) => (i === index ? { ...message, content } : each));
}

/**
 * Before connector_call, each connector tool was a tool of its own, such as
 * shop__find_order. Calls like that in older replies are shown to the model as
 * connector_call, so it calls the same way. Only connector tools have "__" in their name.
 */
export function connectorCallsInHistory(messages: ModelMessage[]): ModelMessage[] {
	return messages.map((message) => {
		if (message.role !== "assistant" && message.role !== "tool") return message;
		if (typeof message.content === "string" || !message.content.some(isOldCall)) return message;
		return { ...message, content: message.content.map(rewrite) } as ModelMessage;
	});
}

type Part = Exclude<Extract<ModelMessage, { role: "assistant" | "tool" }>["content"], string>[number];

type CallOrResult = Extract<Part, { type: "tool-call" | "tool-result" }>;

const isOldCall = (part: Part): part is CallOrResult => (part.type === "tool-call" || part.type === "tool-result") && part.toolName.includes("__");

function rewrite(part: Part): Part {
	if (!isOldCall(part)) return part;
	if (part.type === "tool-call") return { ...part, toolName: CONNECTOR_CALL, input: { tool: part.toolName, input: part.input ?? {} } };
	return { ...part, toolName: CONNECTOR_CALL };
}

/**
 * True when the messages hold the person's approval of this exact call. The call is the
 * latest assistant message's tool-call with this id, which must be a connector_call
 * with this input. That message must hold the approval request for the call, and a
 * later tool message must answer it with approved. A denial wins over an approval.
 * Some providers reuse call ids from turn to turn, so an approval of an earlier call
 * with the same id does not count.
 *
 * The reply loop (loop.ts) checks the request's signature, then runs an approved call
 * with the messages the run started with, which still hold the request and the answer,
 * and drops these parts only after the call. A call the model just made runs with the
 * messages after that model call, which hold no approval request for it, so this is
 * false for it.
 */
export function approvedIn(messages: ModelMessage[], toolCallId: string, input: unknown): boolean {
	let at = messages.length - 1;
	while (at >= 0 && !holdsCall(messages[at]!, toolCallId)) at--;
	const message = messages[at];
	if (!message || message.role !== "assistant" || typeof message.content === "string") return false;
	// The last call with the id in the message, as the SDK's collectToolApprovals takes it.
	const call = [...message.content].reverse().find((part) => part.type === "tool-call" && part.toolCallId === toolCallId);
	if (call?.type !== "tool-call" || call.toolName !== CONNECTOR_CALL || !isDeepEqualData(call.input, input)) return false;
	const requests = new Set(message.content.flatMap((part) => (part.type === "tool-approval-request" && part.toolCallId === toolCallId ? [part.approvalId] : [])));
	const answers = messages
		.slice(at + 1)
		.flatMap((each) => (each.role === "tool" ? each.content : []))
		.filter((part) => part.type === "tool-approval-response" && requests.has(part.approvalId));
	return answers.length > 0 && answers.every((part) => part.type === "tool-approval-response" && part.approved === true);
}

const holdsCall = (message: ModelMessage, toolCallId: string) =>
	message.role === "assistant" && typeof message.content !== "string" && message.content.some((part) => part.type === "tool-call" && part.toolCallId === toolCallId);

