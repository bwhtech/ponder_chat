import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { context, createContextKey, SpanKind, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import { errorType } from "./span.ts";

/**
 * A span for each HTTP request Ponder makes: OpenRouter, MCP servers, web_fetch, search.
 * Both Node's fetch and the undici package (net/NetGuard.ts, fetch-page.ts) report each
 * request on the `undici:request:*` channels, so one listener sees all of them.
 *
 * This takes the place of @opentelemetry/instrumentation-undici, which records the full
 * address and adds a `traceparent` header to each request. Here a span gets the method,
 * the status, the kind of peer, and the host for OpenRouter only. Never the path or the
 * query, and no header goes out: a page or an MCP server learns nothing about the trace.
 * A host is left out too, because a subdomain can carry data a prompt injection planted,
 * and a connector's host tells which apps a person uses.
 *
 * Only requests made inside a trace get a span, so a page load or a poll adds nothing.
 */
export type Peer = "openrouter" | "mcp" | "web";

const PEER = createContextKey("ponder.http.peer");

/** Runs `work` with its HTTP requests marked as going to `peer`. */
export function withPeer<T>(peer: Peer, work: () => T): T {
	return context.with(context.active().setValue(PEER, peer), work);
}

type UndiciRequest = { origin?: string | URL; method?: string };

const tracer = trace.getTracer("ponder.http");
// @opentelemetry/core's key, by its name (createContextKey makes Symbol.for(name)), so this
// file does not load core: other modules import withPeer even with tracing off.
const SUPPRESSED = createContextKey("OpenTelemetry SDK Context Key SUPPRESS_TRACING");
const isTracingSuppressed = (active: Context) => active.getValue(SUPPRESSED) === true;
const spans = new WeakMap<object, Span>();

/** Starts listening. Returns the function that stops it. */
export function listenToHttp(skipOrigin: string): () => void {
	const openRouterHost = hostOf(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api");
	const listeners: Record<string, (message: unknown) => void> = {
		"undici:request:create": (message) => {
			const { request } = message as { request: UndiciRequest };
			const active = context.active();
			if (!trace.getSpan(active)?.spanContext().traceId || isTracingSuppressed(active)) return;
			const origin = String(request.origin ?? "");
			if (origin === skipOrigin) return;
			const host = hostOf(origin);
			const peer: string = (active.getValue(PEER) as Peer | undefined) ?? (host && host === openRouterHost ? "openrouter" : "other");
			const method = (request.method ?? "GET").toUpperCase();
			spans.set(
				request,
				tracer.startSpan(
					method,
					{
						kind: SpanKind.CLIENT,
						attributes: {
							"http.request.method": method,
							"ponder.peer": peer,
							...(peer === "openrouter" && host ? { "server.address": host } : {}),
						},
					},
					active,
				),
			);
		},
		"undici:request:headers": (message) => {
			const { request, response } = message as { request: object; response: { statusCode: number } };
			const span = spans.get(request);
			if (!span) return;
			span.setAttribute("http.response.status_code", response.statusCode);
			if (response.statusCode >= 400) {
				span.setStatus({ code: SpanStatusCode.ERROR });
				span.setAttribute("error.type", String(response.statusCode));
			}
		},
		"undici:request:trailers": (message) => end((message as { request: object }).request),
		"undici:request:error": (message) => {
			const { request, error } = message as { request: object; error: unknown };
			const span = spans.get(request);
			if (!span) return;
			span.setStatus({ code: SpanStatusCode.ERROR });
			span.setAttribute("error.type", errorType(error));
			end(request);
		},
	};
	for (const [channel, listener] of Object.entries(listeners)) subscribe(channel, listener);
	return () => {
		for (const [channel, listener] of Object.entries(listeners)) unsubscribe(channel, listener);
	};
}

function end(request: object) {
	spans.get(request)?.end();
	spans.delete(request);
}

function hostOf(address: string): string | undefined {
	try {
		return new URL(address).hostname;
	} catch {
		return undefined;
	}
}
