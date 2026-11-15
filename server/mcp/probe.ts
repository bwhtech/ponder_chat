import * as Option from "effect/Option";
import * as NetGuard from "../net/NetGuard.ts";
import { runPromise } from "../runtime/runtime.ts";
import { ConnectorProblem, describeError } from "./errors.ts";
import type { AuthKind, Transport } from "./store.ts";

/**
 * What an MCP server URL needs, before the person adds it: which transport answers, and
 * whether it wants no sign-in, an OAuth sign-in, or a key. One initialize request over
 * Streamable HTTP, then the old SSE transport when that is refused. A 401 with OAuth
 * metadata (RFC 9728, or RFC 8414 for older servers) means OAuth; any other 401 means a key.
 */
export type ProbeResult =
	| { ok: true; transport: Transport; auth: AuthKind; name?: string; message: string }
	| { ok: false; message: string };

const TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = "2025-06-18";

export async function probe(address: string): Promise<ProbeResult> {
	// Every request goes through the guarded fetch (net/NetGuard.ts).
	const guard = await runPromise(NetGuard.NetGuard);
	const problem = guard.mcpUrlProblem(address);
	if (Option.isSome(problem)) return { ok: false, message: problem.value };
	const url = new URL(address);
	const guardedFetch = guard.fetch;
	try {
		const http = await initialize(guardedFetch, url);
		if (http.status === 401) return found(url, "http", await authKind(guardedFetch, url, http.headers));
		if (http.ok) {
			const name = await serverName(http);
			await endSession(guardedFetch, url, http.headers.get("mcp-session-id"));
			return found(url, "http", "none", name);
		}
		await http.body?.cancel();
		if ([400, 404, 405, 406, 415].includes(http.status)) {
			const sse = await guardedFetch(url, { headers: { accept: "text/event-stream" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
			await sse.body?.cancel();
			if (sse.status === 401) return found(url, "sse", await authKind(guardedFetch, url, sse.headers));
			if (sse.ok && sse.headers.get("content-type")?.startsWith("text/event-stream")) return found(url, "sse", "none");
		}
		if (http.status === 403) return found(url, "http", "headers");
		return { ok: false, message: `The server answered HTTP ${http.status}. Check the address: it usually ends in /mcp.` };
	} catch (error) {
		return { ok: false, message: describeError(error) };
	}
}

function found(url: URL, transport: Transport, auth: AuthKind, name?: string): ProbeResult {
	const host = url.hostname.replace(/^mcp\./, "");
	const message = {
		none: "No sign-in needed. Anyone with the address can use this server.",
		oauth: `Uses sign-in. You sign in to ${host} in a new window.`,
		headers: "This server needs an API key. Add it as a header below.",
	}[auth];
	return { ok: true, transport, auth, name, message };
}

function initialize(guardedFetch: typeof fetch, url: URL) {
	return guardedFetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "Ponder Chat", version: "1.0.0" } },
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
}

/** The name the server gives itself in its initialize answer, as JSON or as one SSE event. */
async function serverName(response: Response): Promise<string | undefined> {
	try {
		const type = response.headers.get("content-type") ?? "";
		let body: string;
		if (type.startsWith("text/event-stream")) {
			const reader = response.body!.getReader();
			const { value } = await reader.read();
			await reader.cancel();
			body = /^data:\s*(.+)$/m.exec(new TextDecoder().decode(value))?.[1] ?? "";
		} else body = await response.text();
		const result = JSON.parse(body) as { result?: { serverInfo?: { name?: string; title?: string } } };
		return result.result?.serverInfo?.title ?? result.result?.serverInfo?.name;
	} catch {
		await response.body?.cancel().catch(() => undefined);
		return undefined;
	}
}

/** Ends the session the probe opened, as the spec asks of clients that are done. */
async function endSession(guardedFetch: typeof fetch, url: URL, sessionId: string | null) {
	if (!sessionId) return;
	await guardedFetch(url, { method: "DELETE", headers: { "mcp-session-id": sessionId }, signal: AbortSignal.timeout(TIMEOUT_MS) })
		.then((response) => response.body?.cancel())
		.catch(() => undefined);
}

async function authKind(guardedFetch: typeof fetch, url: URL, headers: Headers): Promise<AuthKind> {
	if (/resource_metadata=/i.test(headers.get("www-authenticate") ?? "")) return "oauth";
	const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
	const candidates = [
		`/.well-known/oauth-protected-resource${path}`,
		"/.well-known/oauth-protected-resource",
		"/.well-known/oauth-authorization-server",
	];
	let failure: unknown;
	let answered = false;
	for (const candidate of candidates) {
		const response = await guardedFetch(new URL(candidate, url.origin), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((error) => {
			failure = error;
			return undefined;
		});
		if (!response) continue;
		answered = true;
		if (!response.ok) {
			await response.body?.cancel();
			continue;
		}
		const metadata = (await response.json().catch(() => ({}))) as { authorization_servers?: unknown[]; authorization_endpoint?: string };
		if (metadata.authorization_servers?.length || metadata.authorization_endpoint) return "oauth";
	}
	// No metadata address answered at all (a timeout, the network): that says nothing about
	// the sign-in. "A key" would send the person to the wrong form for an OAuth server.
	if (!answered) {
		console.warn(`connectors: no OAuth metadata address of ${url.host} answered:`, describeError(failure));
		throw new ConnectorProblem("Could not reach the server to check how it signs in. Try again.");
	}
	return "headers";
}
