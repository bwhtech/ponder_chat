import type { ModelMessage } from "ai";
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
 * True when the messages hold the person's approval of this exact call: a signed
 * approval request for the call, and an approving response to that request.
 * WorkflowAgent checks the request's signature, then runs the approved call with these
 * messages, and drops the two parts only after the call. A call that ran without
 * waiting for the person has neither part, so this is false.
 */
export function approvedIn(messages: ModelMessage[], toolCallId: string): boolean {
	const requests = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || typeof message.content === "string") continue;
		for (const part of message.content) {
			if (part.type === "tool-approval-request" && part.toolCallId === toolCallId && !part.isAutomatic) requests.add(part.approvalId);
		}
	}
	return messages.some(
		(message) => message.role === "tool" && message.content.some((part) => part.type === "tool-approval-response" && part.approved === true && requests.has(part.approvalId)),
	);
}
