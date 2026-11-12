import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import type { ConnectorToolSpec } from "../mcp/connectors.ts";
import { CONTEXT_STEP_RETRIES, contextStep } from "./context-step.ts";

/**
 * The person's connector tools in a reply. A live MCP client can't cross a step boundary
 * or survive a restart, so one step reads the tools as plain data (recorded, so a replay
 * uses the same tools), and each call is its own step that connects (mcp/client.ts).
 */

/** The tools of the person's connectors that are on, and a section for the instructions. */
export async function connectorToolsStep(owner: string): Promise<{ specs: ConnectorToolSpec[]; guidance: string }> {
	"use step";
	return contextStep("connectors", `person ${owner}`, async () => {
		const { connectorToolsFor } = await import("../mcp/connectors.ts");
		return connectorToolsFor(owner);
	});
}
connectorToolsStep.maxRetries = CONTEXT_STEP_RETRIES;

/**
 * AI SDK tools from the specs. A tool on "Ask first" waits for the person (needsApproval).
 * needsApproval is a function, never `false`: WorkflowAgent runs an approved call only for
 * a tool that can need approval, and "Always allow" turns the rule to "allow" before the
 * run that carries out the approved call starts.
 */
export function connectorTools(specs: ConnectorToolSpec[], owner: string): ToolSet {
	return Object.fromEntries(
		specs.map((spec) => [
			spec.name,
			tool({
				description: spec.description,
				inputSchema: jsonSchema(spec.inputSchema as JSONSchema7),
				needsApproval: () => spec.ask,
				execute: (input: unknown) => callConnectorToolStep(spec.connectionId, spec.tool, input, owner),
			}),
		]),
	);
}

/**
 * One connector tool call. It returns a failure as its result instead of throwing, and
 * it is never retried: a retried call could create the same issue or send the same
 * email twice. A crash in the middle of the call still runs it again after the restart.
 */
export async function callConnectorToolStep(connectionId: string, toolName: string, input: unknown, owner: string): Promise<string> {
	"use step";
	const { callConnectorTool } = await import("../mcp/connectors.ts");
	return callConnectorTool(connectionId, toolName, input, owner);
}
callConnectorToolStep.maxRetries = 0;
