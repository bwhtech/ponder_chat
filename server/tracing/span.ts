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

/**
 * The kind of an error, for `error.type`: its code, its tag (an Effect error), or its class
 * name. An Effect SQL failure (effect/sql/SqlError) has the Postgres code or the socket's
 * code on its reason's cause, where postgres.js had it on the error, so that comes first.
 * Also used for Effect spans (Tracing.ts). Never the message.
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

/** Sets attributes on the active span, when there is one. */
export function annotate(attributes: SpanAttributes) {
	trace.getActiveSpan()?.setAttributes(defined(attributes));
}

export function defined(attributes: SpanAttributes): Attributes {
	return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as Attributes;
}
