import * as Cause from "effect/Cause";
import { constTrue } from "effect/Function";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";

/**
 * Effect's HttpClient, on Node's fetch, for the services Ponder itself calls: OpenRouter's
 * API, ntfy (notify/Notify.ts) and Cloudflare's email API (email/Email.ts). Addresses
 * that people or the model choose go through net/NetGuard.ts instead.
 *
 * The client's own spans are off. tracing/http.ts already makes a span for each request,
 * from undici's channels, with only what may leave Ponder, and it sends no header. The
 * client's span would be a second one, with the full address, and it would add a
 * `traceparent` header to every request.
 */
export const layer = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(HttpClient.TracerDisabledWhen, constTrue)));

/**
 * What went wrong with a request, for a log line, as the old code printed it: "HTTP 503"
 * for an answer that is not ok, fetch's own message for a network failure ("fetch failed"),
 * and AbortSignal.timeout's message for a timeout. Never the client's message, which
 * holds the address and its query.
 */
export function requestProblem(error: unknown): string {
	if (Cause.isTimeoutError(error)) return "The operation was aborted due to timeout";
	if (HttpClientError.isHttpClientError(error)) {
		const { reason } = error;
		if (reason._tag === "StatusCodeError") return `HTTP ${reason.response.status}`;
		return causeMessage(reason.cause) ?? reason._tag;
	}
	return causeMessage(error) ?? String(error);
}

const causeMessage = (cause: unknown) => (Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message) ? cause.message : undefined);
