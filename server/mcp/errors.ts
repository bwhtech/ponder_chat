import { UnauthorizedError } from "@ai-sdk/mcp";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

/**
 * Errors that connectors show to the person, or to the model, in plain words. Their
 * fields are bounded: a reason, an operation, and at most the header name or the
 * address problem that the person's own input caused. Never a server's text, a token or
 * a URL: what a server or the network said stays in `cause`, and describeError reads it.
 */

/** The connector's sign-in ended or was refused. The person must sign in again. */
export class NeedsSignIn extends Schema.TaggedError<NeedsSignIn>()("NeedsSignIn", {
	/** "unreadable": Ponder can't decrypt the saved sign-in any more (its key changed). */
	reason: Schema.optional(Schema.Literals(["ended", "unreadable"])),
}) {
	override get message() {
		return this.reason === "unreadable" ? "Ponder can't read this connector's sign-in any more. Sign in again." : "The sign-in ended. Sign in again in Settings, Connectors.";
	}
}

/** What the person can fix, each with the sentence they read. */
const PROBLEMS = {
	"not-found": "That connector was not found.",
	duplicate: "You already have a connector for this server.",
	"header-name": (header: string) => `“${header || "(empty)"}” is not a valid header name.`,
	"header-reserved": (header: string) => `Ponder sets the ${header} header itself.`,
	"header-value": (header: string) => `Enter a value for the ${header} header.`,
	/** The address is refused by the net guard; `detail` is its sentence (net/NetGuard.ts mcpUrlProblem). */
	address: (problem: string) => problem,
	"client-id": "Enter the client ID that goes with the secret.",
	"no-key": "Enter the API key as a header.",
	"no-sign-in": "This connector does not use a sign-in.",
	"app-secret-unreadable": "Ponder can't read this connector's app secret any more. Remove the connector and add it again.",
	"key-refused": "The server refused the API key. Enter a new key.",
	"asks-sign-in": "The server now asks for a sign-in or a key.",
	"no-verifier": "This sign-in has no code verifier. Start it again.",
	"sign-in-not-https": "The server's sign-in is not on https.",
	"sign-in-unreachable": "Could not reach the server's sign-in. Try again.",
	"no-redirect": "The server did not ask for a sign-in.",
	"sign-in-expired": "This sign-in expired or was used already. Start it again from Settings, Connectors.",
	"removed-during-sign-in": "The connector was removed during the sign-in.",
	"no-token": "The server did not give Ponder a token.",
	"metadata-unreachable": "Could not reach the server to check how it signs in. Try again.",
} as const;

export type ProblemReason = keyof typeof PROBLEMS;

/** Something the person can fix, with a message they can read. */
export class ConnectorProblem extends Schema.TaggedError<ConnectorProblem>()("ConnectorProblem", {
	reason: Schema.Literals(Object.keys(PROBLEMS) as [ProblemReason, ...ProblemReason[]]),
	/** The header name the person typed, or the net guard's sentence about the address they typed. */
	detail: Schema.optional(Schema.String),
}) {
	override get message() {
		const text = PROBLEMS[this.reason];
		return typeof text === "function" ? text(this.detail ?? "") : text;
	}
}

/**
 * An MCP server, its sign-in or the network failed, through @ai-sdk/mcp: connecting,
 * listing tools, calling one, signing in, or refreshing a token. A timeout of Ponder's own
 * is a TimeoutError in `cause`. The message is fixed: what the server said is in `cause`,
 * for describeError, and never in a field.
 */
export class ConnectorFailed extends Schema.TaggedError<ConnectorFailed>()("ConnectorFailed", {
	operation: Schema.Literals(["connect", "list", "call", "sign-in", "refresh"]),
	cause: Schema.Defect(),
}) {
	override get message() {
		return `The MCP server failed (${this.operation}).`;
	}
}

/**
 * The failure of a call into @ai-sdk/mcp, for Effect.tryPromise's `catch`. A problem or an
 * ended sign-in that Ponder's own OAuth provider threw (ConnectorOAuth.ts) stays itself.
 */
export const sdkFailure =
	(operation: ConnectorFailed["operation"]) =>
	(cause: unknown): ConnectorFailed | ConnectorProblem | NeedsSignIn =>
		cause instanceof ConnectorProblem || cause instanceof NeedsSignIn ? cause : new ConnectorFailed({ operation, cause });

/** The error a ConnectorFailed wraps, or the error itself. */
const inner = (error: unknown) => (error instanceof ConnectorFailed ? error.cause : error);

/** The error's text and its cause's, as the old checks read them. */
function textOf(error: unknown) {
	const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
	return [error instanceof Error ? error.message : String(error), cause?.message].filter(Boolean).join(": ");
}

/** A short reason for an error from a server, the network or the SDK. */
export function describeError(error: unknown): string {
	if (error instanceof NeedsSignIn || error instanceof ConnectorProblem) return error.message;
	const cause = inner(error);
	if (cause !== error) return describeError(cause);
	if (Cause.isTimeoutError(error)) return "The server took too long to answer.";
	const text = textOf(error);
	if (/private network/i.test(text)) return "The server is on a private network, and Ponder can't reach it.";
	if (/abort|timed? ?out/i.test(text)) return "The server took too long to answer.";
	if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return "No server answers at that address. Check it.";
	if (/ECONNREFUSED|ECONNRESET|socket|fetch failed/i.test(text)) return "Could not connect to the server.";
	if (/certificate|SSL|TLS/i.test(text)) return "The server's https certificate is not valid.";
	if (/redirect/i.test(text)) return "The server redirects to another address. Use the address it redirects to.";
	if (/HTTP 401|Unauthorized/i.test(text)) return "The server refused the sign-in or the key.";
	if (/HTTP 403|Forbidden/i.test(text)) return "The server refused access.";
	if (/HTTP 404/i.test(text)) return "There is no MCP server at that address.";
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** The server refused the sign-in or the key (401): a header-key server has no OAuth to fall back on. */
export function isUnauthorized(error: unknown) {
	const cause = inner(error);
	if (cause instanceof UnauthorizedError) return true;
	return cause instanceof Error && /\b401\b|Unauthorized/i.test(`${cause.message} ${cause.cause instanceof Error ? cause.cause.message : ""}`);
}

/** A failure that may pass by itself: a timeout, a 5xx, or the network. */
export function isTransient(error: unknown) {
	const cause = inner(error);
	if (Cause.isTimeoutError(cause)) return true;
	const text = `${cause instanceof Error ? cause.message : String(cause)} ${cause instanceof Error && cause.cause instanceof Error ? cause.cause.message : ""}`;
	return /abort|timed? ?out|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|socket|fetch failed|HTTP 5\d\d|\b50[0-4]\b/i.test(text);
}
