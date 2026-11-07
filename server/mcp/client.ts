import { createMCPClient, UnauthorizedError, type MCPClient } from "@ai-sdk/mcp";
import { UnreadableSecret } from "../secrets.ts";
import { guardedFetch } from "../net-guard.ts";
import { ConnectorProblem, describeError, NeedsSignIn } from "./errors.ts";
import { backgroundOAuth, freshCredentials, type ConnectorOAuth } from "./oauth.ts";
import { readCredentials, setStatus, type Connection, type ServerInfo, type ToolInfo, type Transport } from "./store.ts";
import { toToolInfo } from "./tools.ts";

/**
 * MCP clients. With oauth.ts, the only code that uses @ai-sdk/mcp. Every request goes
 * through the guarded fetch (net-guard.ts), so a server can't reach a private network,
 * and transports refuse redirects.
 */
const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 20_000;
export const CALL_TIMEOUT_MS = 60_000;
const IDLE_MS = 2 * 60_000;
const MAX_TOOLS = 200;

export type Target = { url: string; transport: Transport; headers?: Record<string, string>; oauth?: ConnectorOAuth };

export function openClient(target: Target): Promise<MCPClient> {
	return createMCPClient({
		transport: { type: target.transport, url: target.url, headers: target.headers, authProvider: target.oauth, fetch: guardedFetch, redirect: "error" },
		clientName: "Ponder Chat",
		version: "1.0.0",
		initializationOptions: { timeout: CONNECT_TIMEOUT_MS },
		// A refused sign-in or key is also thrown, and saved as the connection's status.
		onUncaughtError: (error) => {
			if (!/\b401\b|Unauthorized/i.test(String(error))) console.warn(`connectors: ${new URL(target.url).host}: ${describeError(error)}`);
		},
	});
}

/** The server's tools as plain data, every page of them, and what it says about itself. */
export async function listTools(client: MCPClient): Promise<{ tools: ToolInfo[]; serverInfo: ServerInfo }> {
	const tools: ToolInfo[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 20 && tools.length < MAX_TOOLS; page++) {
		const result = await client.listTools({ params: cursor ? { cursor } : undefined, options: { timeout: LIST_TIMEOUT_MS } });
		tools.push(...result.tools.map(toToolInfo));
		cursor = result.nextCursor;
		if (!cursor) break;
	}
	const info = client.serverInfo;
	return {
		tools: tools.slice(0, MAX_TOOLS),
		serverInfo: { name: info?.name, title: info?.title, version: info?.version, instructions: client.instructions?.slice(0, 4_000) },
	};
}

/** Connects once, lists the tools and closes: for a new connector, a new key, and Refresh tools. */
export async function inspect(target: Target) {
	const client = await openClient(target);
	try {
		return await listTools(client);
	} finally {
		await client.close().catch(() => undefined);
	}
}

/** The target for a saved connection, with a token refreshed when it is about to expire. */
export async function targetFor(connection: Connection): Promise<Target> {
	let credentials;
	try {
		credentials = readCredentials(connection);
	} catch (error) {
		if (!(error instanceof UnreadableSecret)) throw error;
		await setStatus(connection.id, "needs_sign_in", "Ponder can't read this connector's sign-in any more. Sign in again.");
		throw new NeedsSignIn("Ponder can't read this connector's sign-in any more. Sign in again.");
	}
	credentials = await freshCredentials(connection, credentials).catch(async (error) => {
		if (error instanceof NeedsSignIn) await setStatus(connection.id, "needs_sign_in", "The sign-in ended. Sign in again.");
		throw error;
	});
	return {
		url: connection.url,
		transport: connection.transport,
		headers: credentials.headers,
		oauth: connection.auth === "oauth" ? backgroundOAuth(connection, credentials) : undefined,
	};
}

/** A pooled client, the calls using it now, and the timer that closes it when it has been idle. */
type Pooled = { client: Promise<MCPClient>; users: number; timer?: ReturnType<typeof setTimeout> };
const pool = new Map<string, Pooled>();

/**
 * Runs `use` with an open client for the connection. One client for each connection is
 * kept for 2 minutes after its last use, so a reply with several calls connects once.
 * A client is never closed while a call uses it. After any error the client leaves the
 * pool, and the next call connects again. A refused sign-in marks the connection
 * "needs_sign_in" and throws NeedsSignIn.
 */
export async function withConnection<T>(connection: Connection, use: (client: MCPClient) => Promise<T>): Promise<T> {
	let entry = pool.get(connection.id);
	if (!entry) {
		entry = { client: targetFor(connection).then(openClient), users: 0 };
		pool.set(connection.id, entry);
	}
	entry.users++;
	clearTimeout(entry.timer);
	try {
		return await use(await entry.client);
	} catch (error) {
		forgetClient(connection.id, entry);
		if (!(error instanceof UnauthorizedError || isUnauthorized(error))) throw error;
		if (connection.auth === "oauth") {
			await setStatus(connection.id, "needs_sign_in", "The server refused the sign-in. Sign in again.");
			throw new NeedsSignIn();
		}
		const message = connection.auth === "headers" ? "The server refused the API key. Enter a new key." : "The server now asks for a sign-in or a key.";
		await setStatus(connection.id, "error", message);
		throw new ConnectorProblem(message);
	} finally {
		entry.users--;
		if (pool.get(connection.id) !== entry) closeWhenIdle(entry);
		else if (!entry.users) idleTimer(connection.id, entry);
	}
}

function idleTimer(id: string, entry: Pooled) {
	clearTimeout(entry.timer);
	entry.timer = setTimeout(() => forgetClient(id, entry), IDLE_MS);
	entry.timer.unref?.();
}

/** Closes a client that left the pool, once no call uses it. */
function closeWhenIdle(entry: Pooled) {
	clearTimeout(entry.timer);
	if (entry.users) return;
	void entry.client.then((client) => client.close()).catch(() => undefined);
}

/** A header-key server answers 401 with no OAuth to fall back on. */
function isUnauthorized(error: unknown) {
	return error instanceof Error && /\b401\b|Unauthorized/i.test(`${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`);
}

/**
 * Takes the connection's client out of the pool: after an error, a new sign-in, new headers,
 * or removal. It closes now, or when the calls using it end. With `only`, just that client:
 * an error on an old client leaves a newer one alone.
 */
export function forgetClient(id: string, only?: Pooled) {
	const entry = pool.get(id);
	if (!entry || (only && entry !== only)) return;
	pool.delete(id);
	closeWhenIdle(entry);
}
