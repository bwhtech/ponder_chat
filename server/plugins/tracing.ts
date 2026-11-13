import { definePlugin } from "nitro";
import { startTracing } from "../tracing/setup.ts";

// Runs first (nitro.config.ts), so the tracer is registered before the workflow worker
// starts and before the AI SDK's telemetry is set up (startup.ts). Off without
// OTEL_EXPORTER_OTLP_ENDPOINT.
export default definePlugin(async () => {
	await startTracing();
});
