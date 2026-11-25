import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import type { Attributes } from "@opentelemetry/api";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import { tracingState } from "./state.ts";

/**
 * Effect's spans, as OpenTelemetry spans of the provider that setup.ts registers. So they
 * go through the same sampler (only inside a reply's trace), the same durable ids and the
 * same allowlist (privacy.ts) as every other span. Without tracing, the global provider
 * hands out spans that record nothing.
 *
 * Parents: an Effect span takes its Effect parent, or else the OpenTelemetry span that is
 * active where the effect runs (a step inside a reply's trace, http.ts's request). Code
 * that an Effect span runs, such as the AI SDK in Effect.tryPromise, sees that span as
 * the active one, so its spans nest under it. server/tracing.check.ts checks both.
 *
 * The provider has the service's Resource (service.name, service.instance.id) in setup.ts,
 * so this layer needs none of its own.
 *
 * A failed span gets `error.type` from the error's code, tag or class name (errorType below);
 * never the message. An interrupted span is not failed: the work was stopped, as with an AbortSignal.
 */
const make = Effect.map(OtelTracer.make, (otel) =>
	Tracer.make({
		span(options) {
			const span = otel.span(options);
			const end = span.end.bind(span);
			span.end = (endTime, exit) => {
				if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)) span.attribute("error.type", errorType(Cause.squash(exit.cause)));
				end(endTime, exit);
			};
			return span;
		},
		context: otel.context,
	}),
);

const otelLayer = Layer.effect(Tracer.Tracer, make).pipe(Layer.provideMerge(OtelTracer.layerGlobalTracer));

/**
 * Without tracing (no OTEL_EXPORTER_OTLP_ENDPOINT, as in production by default), Effect
 * registers no spans at all. Every Effect.fn makes a span, and each one went through
 * OpenTelemetry's global provider, which records nothing but still builds its contexts:
 * about a tenth of a plain request's CPU. Tracing starts before the runtime is built
 * (plugins/tracing.ts), so this is decided once, with tracing on or off for good.
 */
const offLayer = Layer.merge(OtelTracer.layerGlobalTracer, Layer.succeed(References.TracerEnabled, false));

export const layer = Layer.unwrap(Effect.sync(() => (tracingState() ? otelLayer : offLayer)));

/**
 * What a span may carry: how the work went, never what it was about. Counts, sizes, times,
 * ids and outcomes. No message text, file names, tool inputs or outputs, or addresses.
 * privacy.ts drops anything else before a span leaves the process.
 */
export type SpanAttributes = Record<string, string | number | boolean | undefined>;

/** Sets attributes on the current Effect span. Undefined values are left out. */
export const annotate = (attributes: SpanAttributes) => Effect.annotateCurrentSpan(defined(attributes));

export function defined(attributes: SpanAttributes): Attributes {
	return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as Attributes;
}

/**
 * The kind of an error, for `error.type`: its code, its tag (an Effect error), or its class
 * name. An Effect SQL failure (effect/sql/SqlError) has the Postgres code or the socket's
 * code on its reason's cause, so that comes first. Used for Effect spans (above) and for
 * the HTTP spans (http.ts). Never the message.
 */
export function errorType(error: unknown): string {
	if (error && typeof error === "object") {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && /^[\w.-]{1,40}$/.test(code)) return code;
		const { _tag: tag, reason } = error as { _tag?: unknown; reason?: { _tag?: unknown; cause?: unknown } };
		if (tag === "SqlError" && reason && typeof reason === "object") {
			const inner = errorType(reason.cause);
			if (inner !== "_OTHER" && inner !== "Error") return inner;
			if (typeof reason._tag === "string" && /^\w{1,40}$/.test(reason._tag)) return reason._tag;
		}
		if (typeof tag === "string" && /^\w{1,40}$/.test(tag)) return tag;
		const name = (error as { name?: unknown }).name;
		if (typeof name === "string" && /^\w{1,40}$/.test(name)) return name;
	}
	return "_OTHER";
}
