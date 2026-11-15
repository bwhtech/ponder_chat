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
	// Before anything is registered, so a wrong setting leaves tracing off and nothing half set.
	const url = tracesUrl(endpoint);
	const [{ TracerProvider, BatchSpanProcessor }, { AsyncLocalStorageContextManager }, { W3CTraceContextPropagator }, { resourceFromAttributes }, { OTLPTraceExporter }, { OpenTelemetry, OpenTelemetryIdGenerator }] =
		await Promise.all([
			import("@opentelemetry/sdk-trace"),
			import("@opentelemetry/context-async-hooks"),
			import("@opentelemetry/core"),
			import("@opentelemetry/resources"),
			import("@opentelemetry/exporter-trace-otlp-http"),
			import("@ai-sdk/otel"),
		]);

	// The AI SDK's id generator and sampler: it gives a durable run the same
	// span ids in every step and process, and reply-trace.ts uses it to send a reply's root.
	// Every reply is traced (Ponder's traffic is small), and only replies: a span with no
	// parent is dropped, unless it is a reply's root (reply-trace.ts asks for those itself).
	// So a page load, a stream read or a queue poll never starts a trace of its own.
	const ids = new OpenTelemetryIdGenerator({ sampler: onlyInsideTraces });
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
				// A collector that is down or does not answer costs at most EXPORT_TIMEOUT_MS a batch, retries included.
				exporter: new PrivacyExporter(exporter ?? new OTLPTraceExporter({ url: url.href, timeoutMillis: EXPORT_TIMEOUT_MS })),
				exportTimeoutMillis: EXPORT_TIMEOUT_MS,
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
	const stopListening = listenToHttp(url.origin);
	addTraceIdToLogs();
	const state: TracingState = {
		ids,
		integration,
		endpointOrigin: url.origin,
		flush: () => provider.forceFlush(),
		stop: async () => {
			stopListening();
			await provider.shutdown();
		},
	};
	setTracingState(state);
	console.log(`Tracing is on: spans go to ${url.origin}.`);
	return state;
}

const EXPORT_TIMEOUT_MS = 2_000;

/**
 * The name of the span that @effect/sql-pg makes for a statement: the client's database
 * option, else its user name option, else "postgres" (effect/sql/Statement's spanName).
 * runtime/Database.ts gives the client only a URL, so it is "postgres". Database.test.ts checks it.
 */
export const SQL_STATEMENT_SPAN = "postgres";

/**
 * Where spans go: `<endpoint>/v1/traces`. The endpoint must be an http or https address,
 * such as http://127.0.0.1:4318. Without the scheme, "localhost:4318" would parse as an
 * address of scheme "localhost:" and send nothing.
 */
export function tracesUrl(endpoint: string): URL {
	const example = "Use one such as http://127.0.0.1:4318.";
	let base: URL;
	try {
		base = new URL(endpoint.trim());
	} catch {
		throw new Error(`OTEL_EXPORTER_OTLP_ENDPOINT is not an address: "${endpoint}". ${example}`);
	}
	if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error(`OTEL_EXPORTER_OTLP_ENDPOINT must start with http:// or https://. It is "${endpoint}". ${example}`);
	// The endpoint is parsed before /v1/traces is added: "http://" plus the path would
	// parse as host "v1". Cut off after the scheme, it does not parse; this is the guard.
	if (!base.hostname) throw new Error(`OTEL_EXPORTER_OTLP_ENDPOINT has no host: "${endpoint}". ${example}`);
	return new URL(`${base.href.replace(/\/+$/, "")}/v1/traces`);
}

/**
 * Sends the spans still in the batch, for at most `timeoutMs`. Called on SIGTERM
 * (startup.ts) after the database is closed, so a collector that is down or hangs never
 * holds up the stop: the spans that are left are lost.
 */
export async function stopTracing(timeoutMs = 2_000) {
	const state = tracingState();
	if (!state) return;
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), timeoutMs)));
	const stopped = state.stop().then(
		() => "stopped" as const,
		(error) => console.warn("tracing: could not send the last spans:", error instanceof Error ? error.message : error),
	);
	if ((await Promise.race([stopped, late])) === "late") console.warn(`tracing: the last spans were not sent within ${timeoutMs / 1000} seconds.`);
	clearTimeout(timer);
}

/**
 * Samples a span when its parent was sampled; drops a span that has no parent.
 *
 * Also drops the span that Effect's SQL client makes for each statement
 * (SQL_STATEMENT_SPAN). postgres.js made none, and a reply runs many statements:
 * Ponder's own spans around the work, such as thread.load, say enough. A statement's span
 * has no children, so nothing loses its parent.
 */
const onlyInsideTraces = {
	shouldSample(parentContext: Context, _traceId: string, spanName: string) {
		if (spanName === SQL_STATEMENT_SPAN) return { decision: 0 as const, traceState: trace.getSpanContext(parentContext)?.traceState };
		const parent = trace.getSpanContext(parentContext);
		const sampled = parent && isSpanContextValid(parent) && (parent.traceFlags & TraceFlags.SAMPLED) !== 0;
		return { decision: sampled ? (2 as const) : (0 as const), traceState: parent?.traceState };
	},
	toString: () => "PonderReplies",
};

/**
 * The AI SDK's integration, told for every event not to record inputs or outputs,
 * whatever the call asked. Not every call says so (the reply's model calls do,
 * workflow/model-attempt.ts), so without this the integration would record prompts and replies.
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
