import { asSchema, type ModelMessage, type ToolCallPart, type ToolSet } from "ai";
import type { ModelToolCall, ToolSpec } from "./model-call.ts";
import { errorText, isStepRequest, type PlannedCall, type ToolOutcome } from "./tool-outcomes.ts";

export { outcomeParts, toolMessage, toolSpans, type ToolOutcome, type ToolSpan } from "./tool-outcomes.ts";

/**
 * The model's tool calls, checked and run in a step (planToolCallsStep, steps.ts), not in
 * the workflow: the tools' schemas need zod and the AI SDK. A tool with a durable step of
 * its own (web_search, run_python, connector_call…) gives a StepRequest from `execute`,
 * and the workflow runs that step (loop.ts), so a model call that runs again never runs
 * such a tool again. The calls of one response run in parallel.
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

	/**
	 * What to do with each of a response's calls, in their order (planToolCallsStep): ask the
	 * person first, run its step, or its outcome. An `approved` call is not asked about again.
	 */
	async plan(calls: ModelToolCall[], messages: ModelMessage[], { approved = false }: { approved?: boolean } = {}): Promise<PlannedCall[]> {
		const asks = approved ? calls.map(() => false) : await Promise.all(calls.map((call) => this.needsApproval(call, messages)));
		const outcomes = await this.run(
			calls.filter((_, index) => !asks[index]),
			messages,
		);
		let next = 0;
		return calls.map(({ invalid: _invalid, ...call }, index): PlannedCall => {
			if (asks[index]) return { call, ask: true };
			const { output, failed, invalid } = outcomes[next++]!;
			if (!failed && isStepRequest(output)) return { call, ask: false, step: output.stepRequest };
			return { call, ask: false, outcome: { output, failed, ...(invalid && { invalid }) } };
		});
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

	private async execute(call: ToolCallPart, messages: ModelMessage[]): Promise<unknown> {
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
