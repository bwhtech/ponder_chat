import { createHash } from "node:crypto";
import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, TraceFlags, type Context, type Link } from "@opentelemetry/api";
import { defined, tracer, type SpanAttributes } from "./span.ts";
import { tracingState } from "./state.ts";

/**
 * One reply is one trace, though its steps run as separate queue jobs, in replays, and in
 * a new process after a crash. Workflow's own trace context does not survive a restart
 * (the run is queued again without it), so the trace comes from the run id instead: any
 * code that knows the run id knows the reply's trace id and root span id, and nothing
 * is stored.
 *
 * - flow-middleware.ts runs each delivery of the run's steps under the root, so
 *   Workflow's spans, Ponder's spans and the AI SDK's spans all join the trace.
 * - The route (replies.ts, app.ts) does the same once start() gives the run id.
 * - The root span is sent last, when the run is marked finished (runs.ts finishRun), with
 *   the ids below and the start time in the run id. Its children name it as their parent
 *   before it exists; Jaeger puts them together once it arrives.
 *
 * A run that carries on after an approval is a run of its own, so a trace of its own; its
 * request span links to the run it carries on.
 */
const ROOT_NAME = "invoke_agent ponder";

export function replyIds(runId: string) {
	const hash = createHash("sha256").update(`ponder-reply:${runId}`).digest("hex");
	return { traceId: hash.slice(0, 32), spanId: hash.slice(32, 48) };
}

/** `base` with the reply's root as the parent of the spans started in it. */
export function replyContext(runId: string, base: Context = context.active()): Context {
	return trace.setSpanContext(base, { ...replyIds(runId), traceFlags: TraceFlags.SAMPLED, isRemote: true });
}

export function tracingOn() {
	return Boolean(tracingState());
}

/** Runs `work` inside the reply's trace. With tracing off, just runs it. */
export function withReplyTrace<T>(runId: string, work: () => T): T {
	if (!tracingState()) return work();
	return context.with(replyContext(runId), work);
}

/** A link to another run's reply, such as the one a continued run carries on. */
export function linkToReply(runId: string): Link {
	return { context: { ...replyIds(runId), traceFlags: TraceFlags.SAMPLED, isRemote: true } };
}

/** A span of the reply whose times were measured before the run id was known, such as the credit check. */
export function recordReplySpan(runId: string, name: string, start: number, end: number, attributes: SpanAttributes = {}, links: Link[] = []) {
	if (!tracingState()) return;
	tracer.startSpan(name, { startTime: start, attributes: defined(attributes), links }, replyContext(runId)).end(end);
}

export type ReplyOutcome = "saved" | "failed" | "cancelled";

/** Sends the reply's root span. Called once, when the run is marked finished. */
export function endReplyTrace(run: { runId: string; threadId: string; model: string; outcome: ReplyOutcome; continued: boolean }) {
	const state = tracingState();
	if (!state) return;
	const root = state.ids.withIds({ ...replyIds(run.runId), samplingDecision: 2 }, () =>
		tracer.startSpan(
			ROOT_NAME,
			{
				kind: SpanKind.INTERNAL,
				root: true,
				startTime: runStartTime(run.runId),
				attributes: {
					"gen_ai.operation.name": "invoke_agent",
					"gen_ai.agent.name": "ponder",
					"gen_ai.conversation.id": run.threadId,
					"gen_ai.request.model": run.model,
					"workflow.run.id": run.runId,
					"ponder.outcome": run.outcome,
					"ponder.continued": run.continued,
				},
			},
			ROOT_CONTEXT,
		),
	);
	if (run.outcome === "failed") root.setStatus({ code: SpanStatusCode.ERROR });
	root.end();
}

/** When the run started: Workflow's run ids are `wrun_` and a ULID, whose first 10 characters are the time in ms. */
export function runStartTime(runId: string): number | undefined {
	const ulid = runId.replace(/^wrun_/, "").toUpperCase();
	const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	let time = 0;
	for (const char of ulid.slice(0, 10)) {
		const value = CROCKFORD.indexOf(char);
		if (value < 0) return undefined;
		time = time * 32 + value;
	}
	return ulid.length === 26 ? time : undefined;
}

