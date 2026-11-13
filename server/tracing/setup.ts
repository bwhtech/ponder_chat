import { randomUUID } from "node:crypto";
import { context, isSpanContextValid, propagation, trace, TraceFlags, type Context } from "@opentelemetry/api";
import type { SpanExporter } from "@opentelemetry/sdk-trace";
import type { Telemetry } from "ai";
import { listenToHttp } from "./http.ts";
import { addTraceIdToLogs } from "./logs.ts";
import { PrivacyExporter } from "./privacy.ts";
import { setTracingState, tracingState, type TracingState } from "./state.ts";

/**
 * Tracing: each reply is one trace, sent with OTLP over HTTP to OTEL_EXPORTER_OTLP_ENDPOINT
 * (Jaeger on the same machine: deploy/jaeger.yaml). Without it, tracing is off: nothing
 * here is loaded, and the spans that Workflow and span.ts start record nothing.
 *
 * Only what Ponder needs: a tracer provider, a batch of spans, an exporter. No automatic
 * instrumentations, no module hooks. Workflow (@workflow/core) makes its own spans once a
 * provider is registered. The AI SDK makes its own through @ai-sdk/otel (telemetry.ts).
 * HTTP spans come from http.ts. One reply is one trace through reply-trace.ts.
 */
export async function startTracing(endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT, exporter?: SpanExporter): Promise<TracingState | undefined> {
	if (!endpoint || tracingState()) return tracingState();
	const [{ TracerProvider, BatchSpanProcessor }, { AsyncLocalStorageContextManager }, { W3CTraceContextPropagator }, { resourceFromAttributes }, { OTLPTraceExporter }, { OpenTelemetry, OpenTelemetryIdGenerator }] =
		await Promise.all([
			import("@opentelemetry/sdk-trace"),
			import("@opentelemetry/context-async-hooks"),
			import("@opentelemetry/core"),
			import("@opentelemetry/resources"),
			import("@opentelemetry/exporter-trace-otlp-http"),
			import("@ai-sdk/otel"),
		]);

	// The AI SDK's id generator and sampler: it gives a durable WorkflowAgent run the same
	// span ids in every step and process, and reply-trace.ts uses it to send a reply's root.
	// Every reply is traced (Ponder's traffic is small), and only replies: a span with no
	// parent is dropped, unless it is a reply's root (reply-trace.ts asks for those itself).
	// So a page load, a stream read or a queue poll never starts a trace of its own.
	const ids = new OpenTelemetryIdGenerator({ sampler: onlyInsideTraces });
	const url = `${endpoint.replace(/\/+$/, "")}/v1/traces`;
	const provider = new TracerProvider({
		idGenerator: ids,
		sampler: ids,
		resource: resourceFromAttributes({
			"service.name": process.env.OTEL_SERVICE_NAME || "ponder-chat",
			// Tells the processes apart, such as the one that crashed and the one that went on.
			"service.instance.id": randomUUID(),
		}),
		spanProcessors: [
			new BatchSpanProcessor({
				// `exporter` only in server/tracing.check.ts, which reads the spans in memory.
				exporter: new PrivacyExporter(exporter ?? new OTLPTraceExporter({ url })),
				// How long spans wait to be sent in one batch. The e2e tests make it short.
				scheduledDelayMillis: Number(process.env.OTEL_BSP_SCHEDULE_DELAY) || 2_000,
			}),
		],
	});
	context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
	// W3C trace context only. Workflow keeps a run's context in its queue messages with
	// this, and it is never sent to another server (http.ts adds no headers). No baggage:
	// Workflow puts the run id in baggage, and nothing should carry it anywhere.
	propagation.setGlobalPropagator(new W3CTraceContextPropagator());
	trace.setGlobalTracerProvider(provider);

	const integration = withoutContent(
		new OpenTelemetry({
			durable: ids,
			tracer: provider.getTracer("ai"),
			// Cached and reasoning tokens. Every option that records content stays off.
			usage: true,
		}),
	);
	const stopListening = listenToHttp(new URL(url).origin);
	addTraceIdToLogs();
	const state: TracingState = {
		ids,
		integration,
		endpointOrigin: new URL(url).origin,
		flush: () => provider.forceFlush(),
		stop: async () => {
			stopListening();
			await provider.shutdown();
		},
	};
	setTracingState(state);
	console.log(`Tracing is on: spans go to ${new URL(url).origin}.`);
	return state;
}

/** Sends the spans still in the batch. Called on SIGTERM (startup.ts), within its time limit. */
export async function stopTracing() {
	await tracingState()
		?.stop()
		.catch((error) => console.warn("tracing: could not send the last spans:", error instanceof Error ? error.message : error));
}

/** Samples a span when its parent was sampled; drops a span that has no parent. */
const onlyInsideTraces = {
	shouldSample(parentContext: Context) {
		const parent = trace.getSpanContext(parentContext);
		const sampled = parent && isSpanContextValid(parent) && (parent.traceFlags & TraceFlags.SAMPLED) !== 0;
		return { decision: sampled ? (2 as const) : (0 as const), traceState: parent?.traceState };
	},
	toString: () => "PonderReplies",
};

/**
 * The AI SDK's integration, told for every event not to record inputs or outputs,
 * whatever the call asked. WorkflowAgent's calls set nothing (chat.ts), so without this
 * the integration would record prompts and replies.
 */
export function withoutContent<T extends object>(integration: T): T {
	const quiet = (event: unknown) =>
		event && typeof event === "object"
			? new Proxy(event, {
					get: (target, key) => (key === "recordInputs" || key === "recordOutputs" ? false : Reflect.get(target, key, target)),
				})
			: event;
	return new Proxy(integration, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (key === "experimental_durable" && value) {
				const durable = value as unknown as NonNullable<Telemetry["experimental_durable"]>;
				return { captureContext: (event: Parameters<typeof durable.captureContext>[0]) => durable.captureContext(quiet(event) as typeof event) };
			}
			if (typeof value !== "function" || typeof key !== "string" || !/^(on|experimental_on)[A-Z]/.test(key)) return value;
			return (event: unknown, ...rest: unknown[]) => value.call(target, quiet(event), ...rest);
		},
	});
}
