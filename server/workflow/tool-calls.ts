import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { asSchema, type ModelMessage, type ToolCallPart, type ToolResultPart, type ToolSet } from "ai";
import type { ModelToolCall, ToolSpec } from "./model-call.ts";

/**
 * A tool call's outcome: what the model reads, and what the page shows. An invalid call
 * never ran, and the page already shows its error. `start` and `end` are the workflow's
 * clock (the time of the events delivered before and after the call), for its span.
 */
export type ToolOutcome = { call: ToolCallPart; output: unknown; failed: boolean; invalid?: boolean; start: number; end: number };

/** An `execute_tool` span of a call the loop ran, sent by a step (tool-spans.ts): workflow code can't send spans. */
export type ToolSpan = { name: string; callId: string; start: number; end: number; failed: boolean };

/**
 * Runs the model's tool calls in the workflow (loop.ts). Each tool's `execute` makes its
 * own durable step where it has one (steps.ts, connectors.ts), so a model call that runs
 * again never runs a tool again. The calls of one response run in parallel.
 */
export class ToolCalls {
	constructor(private readonly tools: ToolSet) {}

	/** The tools as the model step sends them to the model: no `execute`, and plain JSON schemas. */
	async specs(): Promise<ToolSpec[]> {
		return Promise.all(
			Object.entries(this.tools).map(async ([name, tool]) => ({
				name,
				// Ponder's tools describe themselves with text; a description made per call has no context here.
				description: typeof tool.description === "string" ? tool.description : undefined,
				inputSchema: await asSchema(tool.inputSchema).jsonSchema,
			})),
		);
	}

	/** Whether the call waits for the person: web_fetch to a new page, or a connector tool on "Ask first". */
	async needsApproval(call: ModelToolCall, messages: ModelMessage[]): Promise<boolean> {
		if (call.invalid) return false;
		const rule = this.tools[call.toolName]?.needsApproval;
		if (typeof rule !== "function") return Boolean(rule);
		const input = await this.validInput(call).catch(() => undefined);
		return input !== undefined && Boolean(await rule(input as never, { toolCallId: call.toolCallId, messages, context: undefined as never }));
	}

	/** Whether the tool may run after the person approved it. A tool that can never need approval can't have been asked about. */
	canApprove(toolName: string) {
		const tool = this.tools[toolName];
		return Boolean(tool?.execute && tool.needsApproval);
	}

	/**
	 * Runs the calls in parallel. A call that throws becomes a failed outcome, which the
	 * model reads. An invalid call does not run: its outcome is the SDK's reason.
	 */
	async run(calls: ModelToolCall[], messages: ModelMessage[]): Promise<ToolOutcome[]> {
		return Promise.all(calls.map((call) => this.outcome(call, messages)));
	}

	private async outcome({ invalid, ...call }: ModelToolCall, messages: ModelMessage[]): Promise<ToolOutcome> {
		const start = Date.now();
		if (invalid) return { call, output: invalid, failed: true, invalid: true, start, end: start };
		try {
			return { call, output: await this.execute(call, messages), failed: false, start, end: Date.now() };
		} catch (error) {
			return { call, output: errorText(error), failed: true, start, end: Date.now() };
		}
	}

	private async execute(call: ToolCallPart, messages: ModelMessage[]) {
		const tool = this.tools[call.toolName];
		if (!tool?.execute) throw new Error(`There is no tool named ${call.toolName}.`);
		const input = await this.validInput(call);
		return tool.execute(input as never, { toolCallId: call.toolCallId, messages, context: undefined as never });
	}

	/**
	 * The call's input, checked against the tool's own schema: a zod schema, or a JSON
	 * schema with its own check, such as connector_call's (Catalog.check). The model step
	 * checks nothing. A call that fails the check is never asked about, and never runs.
	 */
	private async validInput(call: ToolCallPart): Promise<unknown> {
		const tool = this.tools[call.toolName];
		const result = await asSchema(tool?.inputSchema).validate?.(call.input);
		if (!result || result.success) return result ? result.value : call.input;
		throw new Error(`Invalid input for ${call.toolName}: ${errorText(result.error)}`);
	}
}

/** The spans of the calls that ran. The name is the tool the model called, such as connector_call: never a connector's own tool. */
export function toolSpans(outcomes: ToolOutcome[]): ToolSpan[] {
	return outcomes.filter(({ invalid }) => !invalid).map(({ call, start, end, failed }) => ({ name: call.toolName, callId: call.toolCallId, start, end, failed }));
}

/** The tool message that gives the model the outcomes. */
export function toolMessage(outcomes: ToolOutcome[], denied: ToolCallPart[] = []): ModelMessage[] {
	const content: ToolResultPart[] = [
		...outcomes.map(({ call, output, failed }) => ({
			type: "tool-result" as const,
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			output: failed ? { type: "error-text" as const, value: String(output) } : modelOutput(output),
		})),
		...denied.map((call) => ({ type: "tool-result" as const, toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "execution-denied" as const } })),
	];
	return content.length ? [{ role: "tool", content }] : [];
}

/** The outcomes as the page shows them, as WorkflowAgent wrote them. */
export function outcomeParts(outcomes: ToolOutcome[]): ModelCallStreamPart[] {
	return outcomes.filter(({ invalid }) => !invalid).map(({ call, output, failed }) =>
		(failed
			? { type: "tool-error", toolCallId: call.toolCallId, toolName: call.toolName, input: call.input, error: output }
			: { type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, input: call.input, output }) as ModelCallStreamPart,
	);
}

function modelOutput(output: unknown): ToolResultPart["output"] {
	if (typeof output === "string") return { type: "text", value: output };
	return { type: "json", value: (output ?? null) as never };
}

function errorText(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
