import { registerTelemetry, type Telemetry } from "ai";
import { RunRecorder } from "./telemetry/run-recorder.ts";
import { migrateRuns } from "./telemetry/store.ts";

export { TITLE_FUNCTION_ID, usageReport } from "./telemetry/store.ts";

/**
 * Telemetry: registers AI SDK telemetry once at server start. Usage and cost per run go
 * to the `runs` table. Chat replies are recorded by their model (workflow/model.ts);
 * this records the other calls, such as thread titles.
 */

/** Who a run is for. Telemetry sees these two values of the runtime context and nothing else. */
export type RunContext = { threadId: string; user: string };

export async function setupTelemetry() {
	const integrations: Telemetry[] = [new RunRecorder()];
	registerTelemetry(...integrations);
	await migrateRuns();
}

/**
 * Settings for the agent of one run: spread them into the ToolLoopAgent settings.
 * Inputs and outputs are never recorded, so an OpenTelemetry exporter never gets prompts or replies.
 */
export function runTelemetry(run: RunContext, functionId = "chat") {
	return {
		runtimeContext: { ...run } as Record<string, unknown>,
		telemetry: {
			functionId,
			includeRuntimeContext: { threadId: true, user: true },
			recordInputs: false,
			recordOutputs: false,
		},
	};
}
