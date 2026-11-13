import { format } from "node:util";
import { trace, TraceFlags } from "@opentelemetry/api";

/**
 * Ends each error and warning logged inside a trace with ` trace_id=<id>`, so a line in
 * the journal leads to its trace in Jaeger. Only when tracing is on (setup.ts). The id
 * goes last, so deploy/sentinel.sh still finds the lines it looks for.
 */
export function addTraceIdToLogs() {
	for (const level of ["error", "warn"] as const) {
		const log = console[level];
		console[level] = (...args: unknown[]) => {
			const span = trace.getActiveSpan()?.spanContext();
			if (!span || !(span.traceFlags & TraceFlags.SAMPLED)) return log(...args);
			log(`${format(...args)} trace_id=${span.traceId}`);
		};
	}
}
