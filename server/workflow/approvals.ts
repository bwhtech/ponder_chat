import type { ModelMessage, ToolApprovalRequest, ToolApprovalResponse, ToolCallPart } from "ai";
import { TOOL_APPROVAL_SECRET_ENV } from "./approval-secret.ts";

/**
 * Tool calls that wait for the person (loop.ts). The reply asks with a signed
 * `tool-approval-request` and ends. The person's answer comes back in the messages the
 * browser sends, and the next run (a `continued` run, runs.ts) carries out the approved
 * calls. The signature shows the model asked for exactly that call, so a page can't
 * approve a call the model never made.
 *
 * The signature is the AI SDK's format (ai-sdk-tool-approval-v1), which WorkflowAgent
 * used, so an approval that waits across a deploy still verifies.
 */

export type Approval = {
	request: ToolApprovalRequest;
	response: ToolApprovalResponse;
	call: ToolCallPart;
	/** The page already gave the model a result for this call: a denial (convertToModelMessages adds it). */
	answered: boolean;
};

/**
 * The approvals the person answered in the thread's last message, in the order the model
 * made the calls. An approved call that already has a result is skipped, so an answer
 * is carried out once. Port of the AI SDK's collectToolApprovals.
 */
export function answeredApprovals(messages: ModelMessage[]): { approved: Approval[]; denied: Approval[] } {
	const last = messages.at(-1);
	if (last?.role !== "tool") return { approved: [], denied: [] };
	const calls = new Map<string, ToolCallPart>();
	const requests = new Map<string, ToolApprovalRequest>();
	for (const part of assistantParts(messages)) {
		if (part.type === "tool-call") calls.set(part.toolCallId, part);
		if (part.type === "tool-approval-request") requests.set(part.approvalId, part);
	}
	const results = new Map(last.content.flatMap((part) => (part.type === "tool-result" ? [[part.toolCallId, part.output.type] as const] : [])));
	const approvals: Approval[] = [];
	for (const response of last.content) {
		if (response.type !== "tool-approval-response") continue;
		const request = requests.get(response.approvalId);
		const call = request && calls.get(request.toolCallId);
		if (!call || approvals.some((approval) => approval.call.toolCallId === call.toolCallId)) continue;
		const result = results.get(call.toolCallId);
		if (result && (response.approved || result !== "execution-denied")) continue;
		approvals.push({ request, response, call, answered: Boolean(result) });
	}
	const order = [...calls.keys()];
	approvals.sort((a, b) => order.indexOf(a.call.toolCallId) - order.indexOf(b.call.toolCallId));
	return { approved: approvals.filter((approval) => approval.response.approved), denied: approvals.filter((approval) => !approval.response.approved) };
}

/** The messages without approval requests and answers, which the model can't read. */
export function withoutApprovals(messages: ModelMessage[]): ModelMessage[] {
	return messages.flatMap((message): ModelMessage[] => {
		if (message.role === "assistant" && typeof message.content !== "string") {
			const content = message.content.filter((part) => part.type !== "tool-approval-request");
			return content.length ? [{ ...message, content }] : [];
		}
		if (message.role === "tool") {
			const content = message.content.filter((part) => part.type !== "tool-approval-response");
			return content.length ? [{ ...message, content }] : [];
		}
		return [message];
	});
}

export type SignedCall = { approvalId: string; toolCallId: string; toolName: string; input: unknown };

/** Signs an approval request. A step, because it reads the secret from the environment. */
export async function signApprovalStep(call: SignedCall): Promise<string> {
	"use step";
	return signApproval(approvalSecret(), call);
}

/** Whether the person's approval carries a valid signature for exactly this call. */
export async function verifyApprovalStep(call: SignedCall, signature: string | undefined): Promise<boolean> {
	"use step";
	return Boolean(signature) && verifyApproval(approvalSecret(), call, signature!);
}

export async function signApproval(secret: string, call: SignedCall): Promise<string> {
	return base64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), await payloadOf(call)));
}

/**
 * Checks a signature with crypto.subtle.verify, as the AI SDK does: in constant time, so
 * how long the check takes tells nothing about the right signature. One of another
 * length fails.
 */
export async function verifyApproval(secret: string, call: SignedCall, signature: string): Promise<boolean> {
	return crypto.subtle.verify("HMAC", await hmacKey(secret), Buffer.from(signature, "base64url"), await payloadOf(call));
}

function hmacKey(secret: string) {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function payloadOf({ approvalId, toolCallId, toolName, input }: SignedCall) {
	return encoder.encode(JSON.stringify(["ai-sdk-tool-approval-v1", approvalId, toolCallId, toolName, await digest(input)]));
}

function approvalSecret() {
	const secret = process.env[TOOL_APPROVAL_SECRET_ENV];
	if (!secret) throw new Error(`${TOOL_APPROVAL_SECRET_ENV} is not set.`);
	return secret;
}

function assistantParts(messages: ModelMessage[]) {
	return messages.flatMap((message) => (message.role === "assistant" && typeof message.content !== "string" ? message.content : []));
}

const encoder = new TextEncoder();

async function digest(value: unknown) {
	return base64url(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(value))));
}

/** JSON with sorted keys, as the AI SDK hashes a tool call's input. */
function canonicalJson(value: unknown): string {
	if (value === null || value === undefined || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function base64url(buffer: ArrayBuffer) {
	return Buffer.from(buffer).toString("base64url");
}
