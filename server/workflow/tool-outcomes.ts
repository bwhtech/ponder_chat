import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai";
import type { WorkspaceSearchInput } from "../workspaces/prompt.ts";
import type { RunPythonInput } from "../python/schema.ts";
import type { WebFetchInput, WebSearchInput } from "../search/schema.ts";

/**
 * Tool calls as the reply's workflow code sees them (loop.ts): their outcomes, and the
 * calls that run in a step of their own. Types and plain functions only, with no imports
 * but types: the workflow's bundle is evaluated again at every resume, so it must not
 * load zod, the AI SDK or the tools' libraries (tool-calls.ts and reply-tools.ts run in
 * steps).
 */

/**
 * A tool call's outcome: what the model reads, and what the page shows. An invalid call
 * never ran, and the page already shows its error. `start` and `end` are the workflow's
 * clock (the time of the events delivered before and after the call), for its span.
 */
export type ToolOutcome = {
	call: ToolCallPart;
	output: unknown;
	failed: boolean;
	invalid?: boolean;
	/** An approved call that did not run, such as one with a signature that is not valid. The page shows why. */
	refused?: boolean;
	start: number;
	end: number;
};

/** An `execute_tool` span of a call the loop ran, sent by a step (tool-spans.ts): workflow code can't send spans. */
export type ToolSpan = { name: string; callId: string; start: number; end: number; failed: boolean };


/**
 * A call that runs in a durable step of its own, so a model call that runs again never
 * runs it again: the tool's `execute` (reply-tools.ts) checks the input and gives this,
 * and the workflow runs the step (loop.ts). Plain data: it is a step's result.
 */
export type StepCall =
	| { tool: "web_search"; input: WebSearchInput }
	| { tool: "web_fetch"; input: WebFetchInput }
	| { tool: "run_python"; input: RunPythonInput }
	| { tool: "workspace_search"; input: WorkspaceSearchInput; scope: { owner: string; workspaceId: string; threadId: string; documentIds: string[] } }
	| { tool: "connector_call"; connectionId: string; toolName: string; input: unknown; approved: boolean };

/** What a tool's `execute` gives for a call that runs in its own step. */
export type StepRequest = { stepRequest: StepCall };

export function isStepRequest(output: unknown): output is StepRequest {
	return typeof output === "object" && output !== null && "stepRequest" in output;
}

/**
 * What the planning step decided for one call (planToolCallsStep): ask the person first,
 * run it in its own step, or its outcome already (an invalid call, a failed check, or a
 * tool that needs no step).
 */
export type PlannedCall =
	| { call: ToolCallPart; ask: true }
	| { call: ToolCallPart; ask: false; step: StepCall }
	| { call: ToolCallPart; ask: false; outcome: Pick<ToolOutcome, "output" | "failed" | "invalid"> };

export function errorText(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

/** The spans of the calls that ran: not an invalid call, nor an approved one that was refused. The name is the tool the model called, such as connector_call: never a connector's own tool. */
export function toolSpans(outcomes: ToolOutcome[]): ToolSpan[] {
	return outcomes.filter(({ invalid, refused }) => !invalid && !refused).map(({ call, start, end, failed }) => ({ name: call.toolName, callId: call.toolCallId, start, end, failed }));
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
