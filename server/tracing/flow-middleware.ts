import { recordReplySpan, withReplyTrace } from "./reply-trace.ts";
import { tracingState } from "./state.ts";

/**
 * Runs each delivery of a workflow run (/.well-known/workflow/v1/flow) inside the trace of
 * the run's reply (reply-trace.ts). Workflow's `workflow.route.flow`, `workflow.execute`
 * and `step.execute` spans start as children of the reply's root, and so does everything
 * the steps do. This holds for the run that goes on after a crash too: its deliveries
 * still name the run.
 *
 * Also records `queue.wait`: from when the message was queued to now.
 *
 * nitro.config.ts registers this as a middleware on the flow route, not lazy, so Nitro
 * calls it with `next`. A boundary, in plain OpenTelemetry: it runs before any step, and
 * `next` runs the whole delivery, which an Effect span could not wrap.
 */
type Delivery = { req: Request };

export default async function traceDelivery(event: Delivery, next: () => unknown) {
	if (!tracingState() || event.req.method !== "POST") return next();
	const message = await readMessage(event.req);
	if (!message) return next();
	return withReplyTrace(message.runId, () => {
		recordQueueWait(message, event.req.headers);
		return next();
	});
}

type Message = { runId: string; requestedAt?: string };

/** The run id from a copy of the body (the queue's JSON message), or undefined. */
async function readMessage(req: Request): Promise<Message | undefined> {
	try {
		const body = (await req.clone().json()) as { runId?: unknown; requestedAt?: unknown };
		if (typeof body?.runId !== "string" || !/^wrun_[0-9A-Z]{26}$/i.test(body.runId)) return undefined;
		return { runId: body.runId, requestedAt: typeof body.requestedAt === "string" ? body.requestedAt : undefined };
	} catch {
		return undefined;
	}
}

function recordQueueWait(message: Message, headers: Headers) {
	const queuedAt = Date.parse(message.requestedAt ?? headers.get("x-vqs-message-created-at") ?? "");
	const now = Date.now();
	if (!Number.isFinite(queuedAt) || queuedAt > now) return;
	const queue = headers.get("x-vqs-queue-name") || undefined;
	const attempt = Number(headers.get("x-vqs-message-attempt"));
	recordReplySpan(message.runId, "queue.wait", queuedAt, now, {
		"messaging.system": "graphile-worker",
		"messaging.destination.name": queue,
		"workflow.delivery.attempt": Number.isFinite(attempt) ? attempt : undefined,
	});
}
