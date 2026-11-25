import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { ModelMessage, ToolCallPart } from "ai";
import type { Estimate } from "../compaction/tokens.ts";
import { answeredApprovals, signApprovalStep, verifyApprovalStep, withoutApprovals, type Approval } from "./approvals.ts";
import { modelCallStep, type ModelCall, type ModelToolCall } from "./model-call.ts";
import { STEP_BOUNDARY } from "./stream-parts.ts";
import type { ToolSetup, ToolsTurn } from "./reply-tools.ts";
import { callConnectorToolStep, planToolCallsStep, runPythonStep, webFetchStep, webSearchStep, workspaceSearchStep } from "./steps.ts";
import { errorText, outcomeParts, toolMessage, toolSpans, type PlannedCall, type StepCall, type ToolOutcome, type ToolSpan } from "./tool-outcomes.ts";

export type Reply = {
	call: Omit<ModelCall, "messages" | "tools" | "estimated">;
	messages: ModelMessage[];
	/** The tools as plain data (reply-tools.ts): the workflow code never loads them. */
	tools: ToolSetup & { turn: ToolsTurn };
	writable: WritableStream<ModelCallStreamPart>;
	/** The most model calls in one reply. */
	maxSteps: number;
	/** Keeps each model call inside the model's window: compaction, between steps too (context-guard.ts). */
	guard?: CallGuard;
};

/** What the loop needs of ContextGuard. */
export type CallGuard = {
	beforeCall(instructions: string, messages: ModelMessage[], call: { first: boolean; measured: number }): Promise<ModelMessage[]>;
	/** The estimate of the call it just prepared. */
	readonly estimate: Estimate;
};

/**
 * The reply's agent loop, in workflow code: a model call, then its tool calls, until the
 * model answers without tools, a call waits for the person, or `maxSteps` model calls
 * are made. Each model call is one durable step with its own retries (model-call.ts), and
 * each tool call is its own step, so nothing that finished runs again after a restart.
 *
 * The tools are plain data here: one step checks a response's calls and runs the ones
 * with no step of their own (planToolCallsStep), and the loop runs the steps of the
 * others (runToolStep). The stream holds what WorkflowAgent wrote, so reply.ts and the
 * page read it as before.
 */
export async function runReply(reply: Reply) {
	await new ReplyLoop(reply).run();
}

class ReplyLoop {
	private messages: ModelMessage[];
	private call: Reply["call"];

	constructor(private readonly reply: Reply) {
		this.messages = reply.messages;
		this.call = reply.call;
	}

	async run() {
		await this.carryOutApprovals();
		const tools = this.reply.tools.specs;
		let measured = 0;
		for (let step = 1; step <= this.reply.maxSteps; step++) {
			const estimated = await this.keepInside(step === 1, measured);
			const response = await modelCallStep({ ...this.call, messages: this.messages, tools, estimated }, this.reply.writable);
			measured = response.inputTokens;
			// Under Auto the rest of the reply stays on the model that answered, which needs its
			// own signed reasoning back with its tool calls; another model could not take it.
			if (response.answeredBy) this.call = { ...this.call, modelId: response.answeredBy };
			this.messages = [...this.messages, ...response.messages];
			if (!response.toolCalls.length) return;
			if (!(await this.runToolCalls(response.toolCalls))) return;
		}
	}

	/**
	 * Before a model call: the guard may summarize the history or trim earlier steps' tool
	 * results, and its messages replace the reply's from then on. Its summary is a step of
	 * its own, outside the model step, so a retried model call never summarizes again, and
	 * a replay reuses the recorded summary. A call it can't fit ends the reply (ContextOverLimitError).
	 */
	private async keepInside(first: boolean, measured: number): Promise<Estimate | undefined> {
		const guard = this.reply.guard;
		if (!guard) return undefined;
		this.messages = await guard.beforeCall(this.reply.call.instructions, this.messages, { first, measured });
		return guard.estimate;
	}

	/** Runs the calls, or asks the person first. False when the reply waits for the person. */
	private async runToolCalls(calls: ModelToolCall[]) {
		const planned = await planToolCallsStep(this.reply.tools.turn, calls, this.messages);
		const asks = planned.filter((plan) => plan.ask).map((plan) => plan.call);
		const outcomes = await Promise.all(planned.filter((plan) => !plan.ask).map((plan) => this.outcomeOf(plan)));
		this.messages = [...this.messages, ...toolMessage(outcomes)];
		if (!asks.length) {
			await writePartsStep(this.reply.writable, [...outcomeParts(outcomes), ...STEP_BOUNDARY], toolSpans(outcomes));
			return true;
		}
		await writePartsStep(this.reply.writable, [...outcomeParts(outcomes), ...(await Promise.all(asks.map(approvalRequest)))], toolSpans(outcomes));
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
		await writePartsStep(this.reply.writable, [...outcomeParts(outcomes), ...deniedParts, ...STEP_BOUNDARY], toolSpans(outcomes));
	}

	/**
	 * Runs an approved call, if the approval is the one Ponder signed and the tool still
	 * asks first. The tool reads the messages with the approval's request and answer still
	 * in them: a connector call checks that the person approved this call (connectors.ts).
	 */
	private async approvedOutcome({ call, request }: Approval): Promise<ToolOutcome> {
		const now = Date.now();
		const refused = (output: string): ToolOutcome => ({ call, output, failed: false, refused: true, start: now, end: now });
		if (!this.reply.tools.approvable.includes(call.toolName)) return refused(`Tool "${call.toolName}" does not require approval`);
		const signed = { approvalId: request.approvalId, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input };
		if (!(await verifyApprovalStep(signed, request.signature))) return refused("The approval is not valid, so the call did not run.");
		const [planned] = await planToolCallsStep(this.reply.tools.turn, [call], this.messages, true);
		return this.outcomeOf(planned!);
	}

	/**
	 * A planned call's outcome: the one the planning step gave, or what its own step gives.
	 * The times are the workflow's clock, for the call's span. A step that throws is a
	 * failed outcome, which the model reads.
	 */
	private async outcomeOf(plan: PlannedCall): Promise<ToolOutcome> {
		const start = Date.now();
		// Never asked: the calls to ask about are left out before, and an approved call is not asked again.
		if (plan.ask) return { call: plan.call, output: "The call waits for the person.", failed: true, start, end: start };
		if ("outcome" in plan) return { call: plan.call, ...plan.outcome, start, end: start };
		try {
			return { call: plan.call, output: await runToolStep(plan.step, this.reply.call), failed: false, start, end: Date.now() };
		} catch (error) {
			return { call: plan.call, output: errorText(error), failed: true, start, end: Date.now() };
		}
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

/**
 * Writes parts to the reply's stream, and sends the spans of the tool calls whose results
 * they are. A step: workflow code can neither write nor send spans.
 */
async function writePartsStep(writable: WritableStream<ModelCallStreamPart>, parts: ModelCallStreamPart[], spans: ToolSpan[] = []) {
	"use step";
	const { sendToolSpans } = await import("./tool-spans.ts");
	sendToolSpans(spans);
	const writer = writable.getWriter();
	try {
		for (const part of parts) await writer.write(part);
	} finally {
		writer.releaseLock();
	}
}

/** Runs a call in its own durable step (reply-tools.ts says which). */
function runToolStep(step: StepCall, { threadId, owner }: { threadId: string; owner: string }): Promise<unknown> {
	switch (step.tool) {
		case "web_search":
			return webSearchStep(step.input, threadId, owner);
		case "web_fetch":
			return webFetchStep(step.input);
		case "run_python":
			return runPythonStep(step.input, threadId, owner);
		case "workspace_search":
			return workspaceSearchStep(step.input, step.scope);
		case "connector_call":
			return callConnectorToolStep(step.connectionId, step.toolName, step.input, owner, step.approved).catch(interruptedOrThrow);
	}
}

/**
 * What the model reads for a connector call that a server stop cut short: it can't tell
 * whether the call took effect. The runtime fails a started step that has no retries left
 * with "Step … exceeded max retries" instead of running it again. Any other error is the
 * call's own, and the model reads it as it is.
 */
function interruptedOrThrow(error: unknown): string {
	if (error instanceof Error && /exceeded max retries/.test(error.message)) {
		return "The server restarted during this call, so it may or may not have taken effect. Check before you call it again.";
	}
	throw error;
}
