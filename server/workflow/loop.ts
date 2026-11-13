import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { ModelMessage, ToolCallPart, ToolSet } from "ai";
import { answeredApprovals, signApprovalStep, verifyApprovalStep, withoutApprovals, type Approval } from "./approvals.ts";
import { modelCallStep, type ModelCall, type ModelToolCall } from "./model-call.ts";
import { STEP_BOUNDARY } from "./stream-parts.ts";
import { outcomeParts, toolMessage, ToolCalls, type ToolOutcome } from "./tool-calls.ts";

export type Reply = {
	call: Omit<ModelCall, "messages" | "tools">;
	messages: ModelMessage[];
	tools: ToolSet;
	writable: WritableStream<ModelCallStreamPart>;
	/** The most model calls in one reply. */
	maxSteps: number;
};

/**
 * The reply's agent loop, in workflow code: a model call, then its tool calls, until the
 * model answers without tools, a call waits for the person, or `maxSteps` model calls
 * are made. Each model call is one durable step with its own retries (model-call.ts), and
 * each tool call is its own step, so nothing that finished runs again after a restart.
 *
 * The stream holds what WorkflowAgent wrote, so reply.ts and the page read it as before.
 */
export async function runReply(reply: Reply) {
	await new ReplyLoop(reply).run();
}

class ReplyLoop {
	private messages: ModelMessage[];
	private readonly tools: ToolCalls;

	constructor(private readonly reply: Reply) {
		this.messages = reply.messages;
		this.tools = new ToolCalls(reply.tools);
	}

	async run() {
		await this.carryOutApprovals();
		const tools = await this.tools.specs();
		for (let step = 1; step <= this.reply.maxSteps; step++) {
			const response = await modelCallStep({ ...this.reply.call, messages: this.messages, tools }, this.reply.writable);
			this.messages = [...this.messages, ...response.messages];
			if (!response.toolCalls.length) return;
			if (!(await this.runToolCalls(response.toolCalls))) return;
		}
	}

	/** Runs the calls, or asks the person first. False when the reply waits for the person. */
	private async runToolCalls(calls: ModelToolCall[]) {
		const asks: ModelToolCall[] = [];
		for (const call of calls) if (await this.tools.needsApproval(call, this.messages)) asks.push(call);
		const outcomes = await this.tools.run(
			calls.filter((call) => !asks.includes(call)),
			this.messages,
		);
		this.messages = [...this.messages, ...toolMessage(outcomes)];
		if (!asks.length) {
			await writePartsStep(this.reply.writable, [...outcomeParts(outcomes), ...STEP_BOUNDARY]);
			return true;
		}
		await writePartsStep(this.reply.writable, [...outcomeParts(outcomes), ...(await Promise.all(asks.map(approvalRequest)))]);
		return false;
	}

	/**
	 * A run after the person answered approvals (a `continued` run, runs.ts): runs the
	 * approved calls and records the denied ones, before the first model call. The page
	 * adds them to the message it already shows.
	 */
	private async carryOutApprovals() {
		const { approved, denied } = answeredApprovals(this.messages);
		if (!approved.length && !denied.length) return;
		const outcomes = await Promise.all(approved.map((approval) => this.approvedOutcome(approval)));
		const unanswered = denied.filter((approval) => !approval.answered).map((approval) => approval.call);
		this.messages = withResults(withoutApprovals(this.messages), toolMessage(outcomes, unanswered));
		const deniedParts = denied.map(({ call }) => ({ type: "tool-output-denied", toolCallId: call.toolCallId }) as unknown as ModelCallStreamPart);
		await writePartsStep(this.reply.writable, [...outcomeParts(outcomes), ...deniedParts, ...STEP_BOUNDARY]);
	}

	/** Runs an approved call, if the approval is the one Ponder signed and the tool still asks first. */
	private async approvedOutcome({ call, request }: Approval): Promise<ToolOutcome> {
		if (!this.tools.canApprove(call.toolName)) return { call, output: `Tool "${call.toolName}" does not require approval`, failed: false };
		const signed = { approvalId: request.approvalId, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input };
		if (!(await verifyApprovalStep(signed, request.signature))) return { call, output: "The approval is not valid, so the call did not run.", failed: false };
		const [outcome] = await this.tools.run([call], withoutApprovals(this.messages));
		return outcome;
	}
}

/** Adds the results to the thread's last tool message, if it ends with one: a call made beside the approved ones has its result there. */
function withResults(messages: ModelMessage[], results: ModelMessage[]): ModelMessage[] {
	const last = messages.at(-1);
	const [added] = results;
	if (last?.role !== "tool" || added?.role !== "tool") return [...messages, ...results];
	return [...messages.slice(0, -1), { ...last, content: [...last.content, ...added.content] }];
}

/** The request that asks the person, signed (approvals.ts). The id is the call's, so a replay asks the same way. */
async function approvalRequest(call: ToolCallPart): Promise<ModelCallStreamPart> {
	const approvalId = `approval-${call.toolCallId}`;
	const signature = await signApprovalStep({ approvalId, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input });
	return { type: "tool-approval-request", approvalId, toolCallId: call.toolCallId, signature };
}

/** Writes parts to the reply's stream. Writing is done in steps: workflow code can't write. */
async function writePartsStep(writable: WritableStream<ModelCallStreamPart>, parts: ModelCallStreamPart[]) {
	"use step";
	const writer = writable.getWriter();
	try {
		for (const part of parts) await writer.write(part);
	} finally {
		writer.releaseLock();
	}
}
