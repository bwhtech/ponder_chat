import { mcpUrlProblem } from "../net-guard.ts";
import { UnreadableSecret } from "../secrets.ts";
import { CALL_TIMEOUT_MS, forgetClient, inspect, targetFor, withConnection } from "./client.ts";
import { ConnectorProblem, describeError, NeedsSignIn } from "./errors.ts";
import { ConnectorOAuth, CALLBACK_PATH, finishSignIn, startSignIn } from "./oauth.ts";
import {
	deleteConnection,
	getConnection,
	hasConnectionTo,
	insertConnection,
	connectionsToRetry,
	listConnections,
	markUsed,
	readCredentials,
	saveCredentials,
	saveTools,
	setLastError,
	setStatus,
	takenSlugs,
	updateConnection,
	connectionsForReply,
	type AuthKind,
	type Connection,
	type Credentials,
	type Rule,
	type Transport,
} from "./store.ts";
import { modelToolName, resultText, ruleOf, slugFor } from "./tools.ts";
import type { ConnectorView } from "../../shared/connectors.ts";
import type { CatalogConnector, CatalogData, CatalogTool } from "./catalog.ts";

/**
 * What Ponder does with connectors, for the routes (routes.ts) and the chat workflow
 * (workflow/connectors.ts). Every function takes the signed-in person and touches only
 * their connections.
 */

/** A connection as the page sees it (shared/connectors.ts). */
export type { ConnectorView };

export function view(connection: Connection): ConnectorView {
	return {
		id: connection.id,
		name: connection.name,
		url: connection.url,
		host: new URL(connection.url).host,
		transport: connection.transport,
		auth: connection.auth,
		status: connection.status,
		enabled: connection.enabled,
		headerNames: connection.headerNames,
		oauthClientId: connection.oauthClientId,
		serverName: connection.serverInfo?.title ?? connection.serverInfo?.name ?? null,
		lastError: connection.lastError,
		toolsCheckedAt: connection.toolsCheckedAt?.toISOString() ?? null,
		lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
		createdAt: connection.createdAt.toISOString(),
		tools: connection.tools.map((tool) => ({
			name: tool.name,
			title: tool.title ?? null,
			description: tool.description ?? null,
			readOnly: tool.readOnly,
			rule: ruleOf(connection, tool),
			modelName: modelToolName(connection.slug, tool.name),
		})),
	};
}

export async function listConnectors(userId: string) {
	return (await listConnections(userId)).map(view);
}

async function mine(userId: string, id: string) {
	const connection = await getConnection(id, userId);
	if (!connection) throw new ConnectorProblem("That connector was not found.");
	return connection;
}

export type NewConnector = {
	name: string;
	url: string;
	transport: Transport;
	auth: AuthKind;
	headers: { name: string; value: string }[];
	clientId?: string;
	clientSecret?: string;
};

/** Headers Ponder sets itself, or that would change how the request travels. */
const RESERVED_HEADERS = /^(host|content-length|content-type|connection|transfer-encoding|accept|mcp-session-id|mcp-protocol-version|cookie)$/i;

function headerRecord(headers: { name: string; value: string }[]) {
	const record: Record<string, string> = {};
	for (const { name, value } of headers) {
		const key = name.trim();
		if (!key && !value.trim()) continue;
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) throw new ConnectorProblem(`“${key || "(empty)"}” is not a valid header name.`);
		if (RESERVED_HEADERS.test(key)) throw new ConnectorProblem(`Ponder sets the ${key} header itself.`);
		if (!value.trim()) throw new ConnectorProblem(`Enter a value for the ${key} header.`);
		record[key] = value.trim();
	}
	return record;
}

/**
 * Adds a connector. With no sign-in or with headers, Ponder connects and lists the tools
 * first, so a wrong address or key fails here. With OAuth, it returns the URL where the
 * person signs in; the connection is saved when the sign-in comes back (completeSignIn).
 */
export async function addConnector(userId: string, origin: string, input: NewConnector): Promise<{ connector: ConnectorView } | { authorizeUrl: string }> {
	const url = input.url.trim();
	const name = input.name.trim();
	const problem = mcpUrlProblem(url);
	if (problem) throw new ConnectorProblem(problem);
	if (await hasConnectionTo(userId, url)) throw new ConnectorProblem("You already have a connector for this server.");
	const headers = headerRecord(input.headers);
	if (input.clientSecret && !input.clientId) throw new ConnectorProblem("Enter the client ID that goes with the secret.");
	const credentials: Credentials = {
		...(Object.keys(headers).length && { headers }),
		...(input.auth === "oauth" && input.clientId && { client: { client_id: input.clientId, ...(input.clientSecret && { client_secret: input.clientSecret }) } }),
	};
	if (input.auth === "headers" && !credentials.headers) throw new ConnectorProblem("Enter the API key as a header.");

	if (input.auth === "oauth") {
		const draft = { name, url, transport: input.transport, oauthClientId: input.clientId || null };
		return { authorizeUrl: await startSignIn({ userId, origin, url, connectionId: null, credentials, draft }) };
	}
	const { tools, serverInfo } = await inspect({ url, transport: input.transport, headers: credentials.headers });
	const connection = await insertConnection({
		userId,
		name,
		slug: slugFor(name, await takenSlugs(userId)),
		url,
		transport: input.transport,
		auth: input.auth,
		oauthClientId: null,
		credentials,
		serverInfo,
		tools,
	});
	if (!connection) throw new ConnectorProblem("You already have a connector for this server.");
	return { connector: view(connection) };
}

/** A new OAuth sign-in for a connection whose sign-in ended. Keeps its client and headers. */
export async function signInAgain(userId: string, origin: string, id: string) {
	const connection = await mine(userId, id);
	if (connection.auth !== "oauth") throw new ConnectorProblem("This connector does not use a sign-in.");
	let credentials: Credentials = {};
	try {
		const saved = readCredentials(connection);
		credentials = { headers: saved.headers, client: saved.client, clientIsDynamic: saved.clientIsDynamic, authServer: saved.authServer };
	} catch (error) {
		if (!(error instanceof UnreadableSecret)) throw error;
		if (connection.oauthClientId) throw new ConnectorProblem("Ponder can't read this connector's app secret any more. Remove the connector and add it again.");
	}
	return { authorizeUrl: await startSignIn({ userId, origin, url: connection.url, connectionId: id, credentials }) };
}

/** The end of an OAuth sign-in: saves the tokens, lists the tools, and returns the connection's id. */
export async function completeSignIn(userId: string, params: { state: string; code: string; issuer?: string }): Promise<{ id: string }> {
	const result = await finishSignIn({
		userId,
		...params,
		url: async (signIn) => signIn.secret.draft?.url ?? (signIn.connectionId ? (await getConnection(signIn.connectionId, userId))?.url : undefined),
	});

	if (result.connectionId) {
		const id = result.connectionId;
		await saveCredentials(id, result.credentials, { status: "connected" });
		forgetClient(id);
		const connection = await mine(userId, id);
		await refreshTools(connection).catch(() => undefined);
		return { id };
	}

	const draft = result.draft!;
	const oauth = new ConnectorOAuth(result.credentials, { redirectUrl: CALLBACK_PATH });
	const { tools, serverInfo } = await inspect({ url: draft.url, transport: draft.transport, headers: result.credentials.headers, oauth });
	const connection = await insertConnection({
		userId,
		name: draft.name,
		slug: slugFor(draft.name, await takenSlugs(userId)),
		url: draft.url,
		transport: draft.transport,
		auth: "oauth",
		oauthClientId: draft.oauthClientId,
		credentials: oauth.credentials,
		serverInfo,
		tools,
	});
	if (!connection) throw new ConnectorProblem("You already have a connector for this server.");
	return { id: connection.id };
}

/**
 * Lists the tools again and saves them. A failure is saved on the connection and thrown.
 * In the background, a connected server that is slow or down for a moment (a timeout, a
 * 5xx, the network) only records the error: the next refresh tries again.
 */
async function refreshTools(connection: Connection, { background = false } = {}) {
	forgetClient(connection.id);
	try {
		const { tools, serverInfo } = await inspect(await targetFor(connection));
		await saveTools(connection.id, tools, serverInfo);
	} catch (error) {
		if (error instanceof NeedsSignIn) throw error;
		if (background && connection.status === "connected" && isTransient(error)) await setLastError(connection.id, describeError(error));
		else await setStatus(connection.id, "error", describeError(error));
		throw error;
	}
}

/** A failure that may pass by itself: a timeout, a 5xx, or the network. */
function isTransient(error: unknown) {
	const text = `${error instanceof Error ? error.message : String(error)} ${error instanceof Error && error.cause instanceof Error ? error.cause.message : ""}`;
	return /abort|timed? ?out|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|socket|fetch failed|HTTP 5\d\d|\b50[0-4]\b/i.test(text);
}

export async function refreshConnector(userId: string, id: string) {
	await refreshTools(await mine(userId, id));
	return view(await mine(userId, id));
}

export type ConnectorChange = {
	name?: string;
	enabled?: boolean;
	/** A rule for each tool named. null puts a tool back on its default. */
	rules?: Record<string, Rule | null>;
	/** New header values. Checked with the server before they are saved. */
	headers?: { name: string; value: string }[];
};

export async function changeConnector(userId: string, id: string, change: ConnectorChange) {
	const connection = await mine(userId, id);
	if (change.headers) {
		const headers = headerRecord(change.headers);
		let saved: Credentials = {};
		try {
			saved = readCredentials(connection);
		} catch (error) {
			if (!(error instanceof UnreadableSecret)) throw error;
		}
		const credentials = { ...saved, headers: Object.keys(headers).length ? headers : undefined };
		// The new headers go with the connection's sign-in, if it has one.
		const target = connection.auth === "oauth" ? await targetFor(connection) : { url: connection.url, transport: connection.transport };
		const { tools, serverInfo } = await inspect({ ...target, headers: credentials.headers });
		await saveCredentials(id, credentials, { status: "connected" });
		await saveTools(id, tools, serverInfo);
		forgetClient(id);
	}
	let toolRules: Record<string, Rule> | undefined;
	if (change.rules) {
		const known = new Set(connection.tools.map((tool) => tool.name));
		toolRules = { ...connection.toolRules };
		for (const [tool, rule] of Object.entries(change.rules)) {
			if (!known.has(tool)) continue;
			if (rule === null) delete toolRules[tool];
			else toolRules[tool] = rule;
		}
	}
	const updated = await updateConnection(id, userId, { name: change.name?.trim() || undefined, enabled: change.enabled, toolRules });
	if (!updated) throw new ConnectorProblem("That connector was not found.");
	return view(updated);
}

export async function removeConnector(userId: string, id: string) {
	forgetClient(id);
	return deleteConnection(id, userId);
}

// For the chat workflow.

/** A safety limit on the tools in one reply's catalog: each is recorded with the reply's run. */
const MAX_CATALOG_TOOLS = 500;
const MAX_NOTES_CHARS = 2_000;
const STALE_TOOLS_MS = 60 * 60_000;
const RETRY_ERROR_MS = 5 * 60_000;

/**
 * The person's connector catalog, as plain data the workflow records: the tools of the
 * connections that are on and signed in, minus the tools turned off, and every
 * connection that is on. Sorted, so the same tools give the same catalog. A tool list
 * more than an hour old is listed again in the background, for the next reply, and so
 * is a connector in "error", so it can recover.
 */
export async function connectorCatalogFor(userId: string): Promise<CatalogData> {
	const connections = await connectionsForReply(userId);
	const signedIn = connections.filter((connection) => connection.status === "connected");
	for (const connection of signedIn) {
		if (!connection.toolsCheckedAt || Date.now() - connection.toolsCheckedAt.getTime() > STALE_TOOLS_MS) void refreshTools(connection, { background: true }).catch(() => undefined);
	}
	// A connector in "error" is tried again every few minutes, so it comes back by itself when its server does.
	for (const connection of await connectionsToRetry(userId, RETRY_ERROR_MS)) void refreshTools(connection, { background: true }).catch(() => undefined);
	const tools = signedIn.flatMap(catalogTools).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const kept = tools.slice(0, MAX_CATALOG_TOOLS);
	if (tools.length > kept.length) console.warn(`connectors: ${userId} has ${tools.length} tools on; the catalog keeps ${kept.length}.`);
	return {
		tools: kept,
		connectors: connections.map((connection) => catalogConnector(connection, tools)),
		leftOut: tools.length - kept.length,
	};
}

function catalogTools(connection: Connection): CatalogTool[] {
	const connector = { slug: connection.slug, name: connection.name, server: serverName(connection) };
	return connection.tools
		.filter((tool) => ruleOf(connection, tool) !== "off")
		.map((tool) => ({
			name: modelToolName(connection.slug, tool.name),
			tool: tool.name,
			...(tool.title && { title: tool.title }),
			description: tool.description ?? "",
			inputSchema: tool.inputSchema,
			connector,
			connectionId: connection.id,
			ask: ruleOf(connection, tool) === "ask",
			readOnly: tool.readOnly,
		}));
}

function catalogConnector(connection: Connection, tools: CatalogTool[]): CatalogConnector {
	const notes = connection.serverInfo?.instructions?.trim().slice(0, MAX_NOTES_CHARS);
	const server = serverName(connection);
	return {
		slug: connection.slug,
		name: connection.name,
		...(server && { server }),
		...(notes && { notes }),
		tools: tools.filter((tool) => tool.connectionId === connection.id).length,
		signedOut: connection.status === "needs_sign_in",
	};
}

const serverName = (connection: Connection) => connection.serverInfo?.title ?? connection.serverInfo?.name ?? undefined;

/**
 * One tool call, for the model. Never throws: a failure is the result, so the model can
 * tell the person, and the workflow does not retry a call that may have changed something.
 */
export async function callConnectorTool(connectionId: string, tool: string, input: unknown, userId: string): Promise<string> {
	const connection = await getConnection(connectionId, userId);
	if (!connection) return "This connector was removed.";
	if (!connection.enabled) return `${connection.name} is turned off in Settings, Connectors.`;
	if (connection.status === "needs_sign_in") return needsSignIn(connection);
	const info = connection.tools.find((each) => each.name === tool);
	if (info && ruleOf(connection, info) === "off") return `The person turned ${info.title ?? tool} off in Settings, Connectors.`;
	try {
		const result = await withConnection(connection, (client) =>
			client.callTool({ name: tool, arguments: (input ?? {}) as Record<string, unknown>, options: { timeout: CALL_TIMEOUT_MS } }),
		);
		await markUsed(connection.id);
		const { text, isError } = resultText(result);
		return isError ? `${connection.name} answered with an error:\n${text}` : text;
	} catch (error) {
		if (error instanceof NeedsSignIn) return needsSignIn(connection);
		console.warn(`connectors: ${connection.name} ${tool}: ${describeError(error)}`);
		return `${connection.name} could not run ${tool}: ${describeError(error)}`;
	}
}

const needsSignIn = (connection: Connection) =>
	`${connection.name} needs the person to sign in again, in Settings, Connectors. Tell them, and don't try its tools again in this reply.`;
