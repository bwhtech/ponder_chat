/** Errors that connectors show to the person, or to the model, in plain words. */

/** The connector's sign-in ended or was refused. The person must sign in again. */
export class NeedsSignIn extends Error {
	constructor(message = "The sign-in ended. Sign in again in Settings, Connectors.") {
		super(message);
	}
}

/** Something the person can fix, with a message they can read. */
export class ConnectorProblem extends Error {}

/** A short reason for an error from a server, the network or the SDK. */
export function describeError(error: unknown): string {
	if (error instanceof NeedsSignIn || error instanceof ConnectorProblem) return error.message;
	const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
	const text = [error instanceof Error ? error.message : String(error), cause?.message].filter(Boolean).join(": ");
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
