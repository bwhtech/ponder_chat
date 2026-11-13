import { SpanStatusCode } from "@opentelemetry/api";
import { tracer } from "../tracing/span.ts";
import type { ToolSpan } from "./tool-calls.ts";

/**
 * The `execute_tool <name>` spans of the tool calls the reply loop ran (loop.ts). The loop
 * runs in workflow code, which can't send spans, so the step that writes the calls'
 * results sends them, in the reply's trace (tracing/flow-middleware.ts), with the times
 * the loop measured. The spans of a tool's own steps, such as web_fetch.read, are their
 * siblings, not their children. server/tracing/privacy.ts takes a connector's slug out of
 * a name or a call id. With tracing off, nothing is sent.
 */
export function sendToolSpans(spans: ToolSpan[]) {
	for (const { name, callId, start, end, failed } of spans) {
		const span = tracer.startSpan(`execute_tool ${name}`, {
			startTime: start,
			attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name, "gen_ai.tool.call.id": callId },
		});
		if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
		span.end(end);
	}
}
