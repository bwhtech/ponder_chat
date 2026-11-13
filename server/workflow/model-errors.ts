/**
 * Which failed model calls a reply tries again, and when (model-call.ts). One budget
 * covers errors and crashes: each attempt of the model step is one request to OpenRouter,
 * and the step has MODEL_CALL_ATTEMPTS attempts. No imports, so the workflow can load it.
 */
export const MODEL_CALL_ATTEMPTS = 3;
/**
 * No first chunk for this long: the call has stalled. Generous, because a reasoning model
 * that does not stream its thinking can think for minutes, and each stall is billed.
 */
export const FIRST_CHUNK_MS = 10 * 60_000;
/** No chunk for this long after the first one: the stream has stalled. */
export const NEXT_CHUNK_MS = 2 * 60_000;

/** Waits before the 2nd and the 3rd attempt. */
const BACKOFF_MS = [2_000, 8_000];
const JITTER_MS = 1_000;
/** The most a 429's Retry-After can make an attempt wait. */
const MAX_RETRY_AFTER_MS = 30_000;
const RETRYABLE_STATUS = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500;
/** The AI SDK marks its errors with this symbol. */
const SDK_ERROR = Symbol.for("vercel.ai.error");
/** AI SDK errors with no HTTP status that another attempt can fix: a stream that broke or came back empty. */
const SDK_STREAM_ERRORS = new Set(["AI_NoOutputGeneratedError", "AI_TypeValidationError", "AI_JSONParseError", "AI_EmptyResponseBodyError"]);

export type Verdict = { retry: false; reason: string } | { retry: true; afterMs: number; reason: string };

/** Thrown by the model step when the stream sends nothing for too long. */
export class ModelStalledError extends Error {
	override name = "ModelStalledError";
}

/**
 * Whether `attempt` (1, 2, …) failed in a way another attempt can fix, and how long to
 * wait first. These are not tried again, because they would fail again:
 * - a model that refused the request with a 4xx: a bad request, the key, OpenRouter
 *   credit or a missing model;
 * - an AI SDK error with no HTTP status, such as a prompt it can't send, unless the
 *   stream broke or came back empty.
 * Every other error is: 408, 409, 429, 5xx, a network error, a stall, a broken or empty
 * stream, and an error of the server itself, such as a database that a deploy closed.
 */
export function classifyModelError(error: unknown, attempt: number, random = Math.random): Verdict {
	const reason = describe(error);
	if (attempt >= MODEL_CALL_ATTEMPTS) return { retry: false, reason };
	if (causes(error).some(isRefusal)) return { retry: false, reason };
	const backoff = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] + Math.floor(random() * JITTER_MS);
	return { retry: true, afterMs: Math.max(backoff, retryAfterMs(error)), reason };
}

/** The model's answer was a 4xx other than 408, 409 and 429, or the AI SDK refused the call itself. */
function isRefusal(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const status = statusOf(error);
	if (status !== undefined) return status >= 400 && status < 500 && !RETRYABLE_STATUS(status);
	const { name, isRetryable } = error as { name?: string; isRetryable?: unknown };
	// A network failure is an APICallError with no status, marked retryable.
	return SDK_ERROR in error && isRetryable !== true && !SDK_STREAM_ERRORS.has(name ?? "");
}

/** The HTTP status of an APICallError, a StreamProviderError, or OpenRouter's `{ code, message }` error chunk. */
function statusOf(error: object): number | undefined {
	const { statusCode, code } = error as { statusCode?: unknown; code?: unknown };
	if (typeof statusCode === "number") return statusCode;
	return typeof code === "number" ? code : undefined;
}

/** The error and every error it wraps. A network failure is often the cause of a "fetch failed". */
function causes(error: unknown): unknown[] {
	const chain: unknown[] = [];
	for (let at = error; at && chain.length < 5 && !chain.includes(at); at = (at as { cause?: unknown }).cause) chain.push(at);
	return chain;
}

function retryAfterMs(error: unknown): number {
	const headers = (error as { responseHeaders?: Record<string, string> } | undefined)?.responseHeaders;
	const seconds = Number(headers?.["retry-after"]);
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 0;
}

function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
	return String(error);
}
