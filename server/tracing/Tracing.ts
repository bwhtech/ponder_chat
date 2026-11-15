import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import { defined, errorType, type SpanAttributes } from "./span.ts";

/**
 * Effect's spans, as OpenTelemetry spans of the provider that setup.ts registers. So they
 * go through the same sampler (only inside a reply's trace), the same durable ids and the
 * same allowlist (privacy.ts) as every other span. Without tracing, the global provider
 * hands out spans that record nothing, as for span.ts.
 *
 * Parents: an Effect span takes its Effect parent, or else the OpenTelemetry span that is
 * active where the effect runs (a step inside a reply's trace, http.ts's request). Code
 * that an Effect span runs, such as the AI SDK in Effect.tryPromise, sees that span as
 * the active one, so its spans nest under it. server/tracing.check.ts checks both.
 *
 * The provider has the service's Resource (service.name, service.instance.id) in setup.ts,
 * so this layer needs none of its own.
 *
 * A failed span gets `error.type` from the error's code, tag or class name (span.ts's
 * errorType), as span.ts's `failed` does; never the message. An interrupted span is not
 * failed: the work was stopped, as with an AbortSignal.
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

export const layer = Layer.effect(Tracer.Tracer, make).pipe(Layer.provideMerge(OtelTracer.layerGlobalTracer));

/**
 * Sets attributes on the current Effect span, as span.ts's `annotate` does on the active
 * span. Undefined values are left out. The same rule: counts, sizes, ids and outcomes, never content.
 */
export const annotate = (attributes: SpanAttributes) => Effect.annotateCurrentSpan(defined(attributes));
