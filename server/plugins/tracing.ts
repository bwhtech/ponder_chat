import { definePlugin } from "nitro";
import { startTracing } from "../tracing/setup.ts";

// Runs first (nitro.config.ts), so the tracer is registered before the workflow worker
// starts and before the AI SDK's telemetry is set up (startup.ts). Off without
// OTEL_EXPORTER_OTLP_ENDPOINT. A wrong setting leaves tracing off and Ponder running:
// Nitro waits for each plugin, so a throw here would keep startup.ts from running.
export default definePlugin(async () => {
	try {
		await startTracing();
	} catch (error) {
		console.warn(`Tracing is off: ${error instanceof Error ? error.message : error}`);
	}
});
