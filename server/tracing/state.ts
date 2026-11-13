import type { OpenTelemetry, OpenTelemetryIdGenerator } from "@ai-sdk/otel";
import type { Telemetry } from "ai";

/**
 * What setup.ts made when tracing is on. On globalThis, because the build can load a
 * module in more than one chunk (the workflow's steps, the routes, the plugins), and all
 * of them must see the same tracer.
 */
export type TracingState = {
	/** Makes the ids of a span that is sent later, such as a reply's root (reply-trace.ts). */
	ids: OpenTelemetryIdGenerator;
	/** The AI SDK's OpenTelemetry integration, for registerTelemetry (telemetry.ts). */
	integration: Telemetry & Pick<OpenTelemetry, "experimental_durable">;
	/** Sends the spans that wait in the batch. */
	flush: () => Promise<void>;
	/** Sends the spans that wait in the batch, and stops. */
	stop: () => Promise<void>;
	/** The OTLP endpoint's origin, which the HTTP spans leave out (http.ts). */
	endpointOrigin: string;
};

const KEY = Symbol.for("ponder.tracing");

export function tracingState(): TracingState | undefined {
	return (globalThis as { [KEY]?: TracingState })[KEY];
}

export function setTracingState(state: TracingState) {
	(globalThis as { [KEY]?: TracingState })[KEY] = state;
}
