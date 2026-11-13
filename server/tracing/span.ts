import { context, SpanStatusCode, trace, type Attributes, type Context, type Span } from "@opentelemetry/api";

/**
 * Ponder's own spans, around a piece of work, with a name and attributes chosen here.
 * Without a tracer provider (tracing off, server/tracing/setup.ts) the API hands out spans
 * that record nothing, so this costs almost nothing.
 *
 * Attributes say how the work went, never what it was about: counts, sizes, times, ids
 * and outcomes. No message text, file names, tool inputs or outputs, or addresses.
 * server/tracing/privacy.ts drops anything else before a span leaves the process.
 */
export const tracer = trace.getTracer("ponder");

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

/** Runs `work` in a span. A failure sets the span's status and `error.type`, never the error's message. */
export async function span<T>(name: string, attributes: SpanAttributes, work: (span: Span) => Promise<T>, parent?: Context): Promise<T> {
	return tracer.startActiveSpan(name, { attributes: defined(attributes) }, parent ?? context.active(), async (active) => {
		try {
			return await work(active);
		} catch (error) {
			failed(active, error);
			throw error;
		} finally {
			active.end();
		}
	});
}

/** Marks a span failed with the kind of error: its class name or code, not its message. */
export function failed(active: Span, error: unknown) {
	active.setStatus({ code: SpanStatusCode.ERROR });
	active.setAttribute("error.type", errorType(error));
}

export function errorType(error: unknown): string {
	if (error && typeof error === "object") {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && /^[\w.-]{1,40}$/.test(code)) return code;
		const name = (error as { name?: unknown }).name;
		if (typeof name === "string" && /^\w{1,40}$/.test(name)) return name;
	}
	return "_OTHER";
}

/** Sets attributes on the active span, when there is one. */
export function annotate(attributes: SpanAttributes) {
	trace.getActiveSpan()?.setAttributes(defined(attributes));
}

export function defined(attributes: SpanAttributes): Attributes {
	return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as Attributes;
}
