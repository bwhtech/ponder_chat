import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { SqlError } from "effect/sql/SqlError";
import * as NetGuard from "../net/NetGuard.ts";
import type { UnreadableSecret } from "../secrets/Secrets.ts";
import * as Tracing from "../tracing/Tracing.ts";
import type { ConnectorView } from "../../shared/connectors.ts";
import type { CatalogConnector, CatalogData, CatalogTool, OffTool } from "./catalog.ts";
import * as ConnectorOAuth from "./ConnectorOAuth.ts";
import { CALLBACK_PATH } from "./ConnectorOAuth.ts";
import * as ConnectorStore from "./ConnectorStore.ts";
import type { AuthKind, Connection, Credentials, Rule, Transport } from "./ConnectorStore.ts";
import { ConnectorFailed, ConnectorProblem, describeError, isTransient, NeedsSignIn } from "./errors.ts";
import * as McpClients from "./McpClients.ts";
import { modelToolName, resultText, ruleOf, slugFor } from "./tools.ts";

/**
 * What Ponder does with connectors, for the routes (routes.ts) and the chat workflow
 * (workflow/connectors.ts). Every method takes the signed-in person and touches only
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

export type NewConnector = {
	name: string;
	url: string;
	transport: Transport;
	auth: AuthKind;
	headers: { name: string; value: string }[];
	clientId?: string;
	clientSecret?: string;
};

export type ConnectorChange = {
	name?: string;
	enabled?: boolean;
	/** A rule for each tool named. null puts a tool back on its default. */
	rules?: Record<string, Rule | null>;
	/** New header values. Checked with the server before they are saved. */
	headers?: { name: string; value: string }[];
};

/** Headers Ponder sets itself, or that would change how the request travels. */
const RESERVED_HEADERS = /^(host|content-length|content-type|connection|transfer-encoding|accept|mcp-session-id|mcp-protocol-version|cookie)$/i;

/** The headers the person entered, checked. Not traced: it is a few string checks. */
const headerRecord = Effect.fnUntraced(function* (headers: { name: string; value: string }[]) {
	const record: Record<string, string> = {};
	for (const { name, value } of headers) {
		const key = name.trim();
		if (!key && !value.trim()) continue;
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) return yield* new ConnectorProblem({ reason: "header-name", detail: key });
		if (RESERVED_HEADERS.test(key)) return yield* new ConnectorProblem({ reason: "header-reserved", detail: key });
		if (!value.trim()) return yield* new ConnectorProblem({ reason: "header-value", detail: key });
		record[key] = value.trim();
	}
	return record;
});

/** How a person's action on connectors can fail: what they can fix, a server's failure, the database. */
export type ConnectorError = ConnectorProblem | NeedsSignIn | ConnectorFailed | SqlError | UnreadableSecret;

export class Connectors extends Context.Service<
	Connectors,
	{
		readonly listConnectors: (userId: string) => Effect.Effect<ConnectorView[], SqlError>;
		/**
		 * Adds a connector. With no sign-in or with headers, Ponder connects and lists the tools
		 * first, so a wrong address or key fails here. With OAuth, it gives the URL where the
		 * person signs in; the connection is saved when the sign-in comes back (completeSignIn).
		 */
		readonly addConnector: (userId: string, origin: string, input: NewConnector) => Effect.Effect<{ connector: ConnectorView } | { authorizeUrl: string }, ConnectorError>;
		/** A new OAuth sign-in for a connection whose sign-in ended. Keeps its client and headers. */
		readonly signInAgain: (userId: string, origin: string, id: string) => Effect.Effect<{ authorizeUrl: string }, ConnectorError>;
		/** The end of an OAuth sign-in: saves the tokens, lists the tools, and gives the connection's id. */
		readonly completeSignIn: (userId: string, params: { state: string; code: string; issuer?: string }) => Effect.Effect<{ id: string }, ConnectorError>;
		readonly refreshConnector: (userId: string, id: string) => Effect.Effect<ConnectorView, ConnectorError>;
		readonly changeConnector: (userId: string, id: string, change: ConnectorChange) => Effect.Effect<ConnectorView, ConnectorError>;
		/** False when the connection is not the person's. */
		readonly removeConnector: (userId: string, id: string) => Effect.Effect<boolean, SqlError>;
		/**
		 * The person's connector catalog, as plain data the workflow records: the tools of the
		 * connections that are on and signed in, minus the tools turned off, and every
		 * connection that is on, with or without tools. Sorted, so the same tools give the same
		 * catalog. A tool list more than an hour old is listed again in the background, for the
		 * next reply, and so is a connector in "error", so it can recover.
		 */
		readonly connectorCatalogFor: (userId: string) => Effect.Effect<CatalogData, SqlError>;
		/**
		 * One tool call, for the model. Never fails but on the database: a failure is the
		 * result, so the model can tell the person, and the workflow does not retry a call that
		 * may have changed something.
		 *
		 * `approved` says the person approved this exact call: the workflow takes it from the
		 * signed approval in the reply's messages (workflow/connector-messages.ts approvedIn).
		 * The rule is read again here, as the last guard: a tool on "Ask first" runs only when
		 * the call was approved, however the call got here.
		 */
		readonly callConnectorTool: (connectionId: string, tool: string, input: unknown, userId: string, approved: boolean) => Effect.Effect<string, SqlError>;
	}
>()("ponder/mcp/Connectors") {}

// For the chat workflow.

/** Safety limits on one reply's catalog: it is recorded with the reply's run. */
const MAX_CATALOG_TOOLS = 500;
const MAX_CATALOG_CHARS = 2_000_000;
/** The tools that are off are named so a call to one says so; this many at most, in this much JSON, within MAX_CATALOG_CHARS. */
const MAX_OFF_TOOLS = 500;
const MAX_OFF_CHARS = 100_000;
const MAX_NOTES_CHARS = 2_000;
const STALE_TOOLS_MS = 60 * 60_000;
const RETRY_ERROR_MS = 5 * 60_000;

const make = Effect.gen(function* () {
	const store = yield* ConnectorStore.ConnectorStore;
	const oauth = yield* ConnectorOAuth.ConnectorOAuth;
	const clients = yield* McpClients.McpClients;
	const guard = yield* NetGuard.NetGuard;
	// The tool lists read again in the background, after a reply's catalog. They run in the
	// service's scope, so the step that started one does not wait for it or stop it.
	const background = yield* FiberSet.make();

	const mine = Effect.fn("Connectors.mine")(function* (userId: string, id: string) {
		const connection = yield* store.getConnection(id, userId);
		if (Option.isNone(connection)) return yield* new ConnectorProblem({ reason: "not-found" });
		return connection.value;
	});

	const listConnectors = Effect.fn("Connectors.listConnectors")(function* (userId: string) {
		return (yield* store.listConnections(userId)).map(view);
	});

	const addConnector = Effect.fn("Connectors.addConnector")(function* (userId: string, origin: string, input: NewConnector) {
		const url = input.url.trim();
		const name = input.name.trim();
		const problem = guard.mcpUrlProblem(url);
		if (Option.isSome(problem)) return yield* new ConnectorProblem({ reason: "address", detail: problem.value });
		if (yield* store.hasConnectionTo(userId, url)) return yield* new ConnectorProblem({ reason: "duplicate" });
		const headers = yield* headerRecord(input.headers);
		if (input.clientSecret && !input.clientId) return yield* new ConnectorProblem({ reason: "client-id" });
		const credentials: Credentials = {
			...(Object.keys(headers).length && { headers }),
			...(input.auth === "oauth" && input.clientId && { client: { client_id: input.clientId, ...(input.clientSecret && { client_secret: input.clientSecret }) } }),
		};
		if (input.auth === "headers" && !credentials.headers) return yield* new ConnectorProblem({ reason: "no-key" });

		if (input.auth === "oauth") {
			const draft = { name, url, transport: input.transport, oauthClientId: input.clientId || null };
			return { authorizeUrl: yield* oauth.startSignIn({ userId, origin, url, connectionId: null, credentials, draft }) };
		}
		const { tools, serverInfo } = yield* clients.inspect({ url, transport: input.transport, headers: credentials.headers });
		const connection = yield* store.insertConnection({
			userId,
			name,
			slug: slugFor(name, yield* store.takenSlugs(userId)),
			url,
			transport: input.transport,
			auth: input.auth,
			oauthClientId: null,
			credentials,
			serverInfo,
			tools,
		});
		if (Option.isNone(connection)) return yield* new ConnectorProblem({ reason: "duplicate" });
		return { connector: view(connection.value) };
	});

	const signInAgain = Effect.fn("Connectors.signInAgain")(function* (userId: string, origin: string, id: string) {
		const connection = yield* mine(userId, id);
		if (connection.auth !== "oauth") return yield* new ConnectorProblem({ reason: "no-sign-in" });
		const credentials = yield* store.readCredentials(connection).pipe(
			Effect.map((saved): Credentials => ({ headers: saved.headers, client: saved.client, clientIsDynamic: saved.clientIsDynamic, authServer: saved.authServer })),
			Effect.catchTags({
				UnreadableSecret: () => (connection.oauthClientId ? Effect.fail(new ConnectorProblem({ reason: "app-secret-unreadable" })) : Effect.succeed<Credentials>({})),
			}),
		);
		return { authorizeUrl: yield* oauth.startSignIn({ userId, origin, url: connection.url, connectionId: id, credentials }) };
	});

	/**
	 * Lists the tools again and saves them. A failure is saved on the connection and given.
	 * In the background, a connected server that is slow or down for a moment (a timeout, a
	 * 5xx, the network) only records the error: the next refresh tries again.
	 */
	const refreshTools = Effect.fn("Connectors.refreshTools")(function* (connection: Connection, options: { background?: boolean } = {}) {
		yield* clients.forget(connection.id);
		yield* clients.targetFor(connection).pipe(
			Effect.flatMap(clients.inspect),
			Effect.flatMap(({ tools, serverInfo }) => store.saveTools(connection.id, tools, serverInfo)),
			Effect.tapError((error) => {
				if (error instanceof NeedsSignIn) return Effect.void;
				if (options.background && connection.status === "connected" && isTransient(error)) return store.setLastError(connection.id, describeError(error));
				return store.setStatus(connection.id, "error", describeError(error));
			}),
		);
	});

	const refreshLater = (connection: Connection) => FiberSet.run(background, refreshTools(connection, { background: true }).pipe(Effect.ignore));

	const completeSignIn = Effect.fn("Connectors.completeSignIn")(function* (userId: string, params: { state: string; code: string; issuer?: string }) {
		const result = yield* oauth.finishSignIn({
			userId,
			...params,
			url: (signIn) => {
				if (signIn.secret.draft) return Effect.succeed(signIn.secret.draft.url);
				if (!signIn.connectionId) return Effect.succeed(undefined);
				return Effect.map(store.getConnection(signIn.connectionId, userId), (found) => Option.getOrUndefined(Option.map(found, (connection) => connection.url)));
			},
		});

		if (result.connectionId) {
			const id = result.connectionId;
			yield* store.saveCredentials(id, result.credentials, { status: "connected" });
			yield* clients.forget(id);
			const connection = yield* mine(userId, id);
			// A failure is saved on the connection, and the sign-in itself worked.
			yield* refreshTools(connection).pipe(Effect.ignore);
			return { id };
		}

		const draft = result.draft!;
		const provider = oauth.unsaved(result.credentials, CALLBACK_PATH);
		const { tools, serverInfo } = yield* clients.inspect({ url: draft.url, transport: draft.transport, headers: result.credentials.headers, oauth: provider });
		const connection = yield* store.insertConnection({
			userId,
			name: draft.name,
			slug: slugFor(draft.name, yield* store.takenSlugs(userId)),
			url: draft.url,
			transport: draft.transport,
			auth: "oauth",
			oauthClientId: draft.oauthClientId,
			credentials: provider.credentials,
			serverInfo,
			tools,
		});
		if (Option.isNone(connection)) return yield* new ConnectorProblem({ reason: "duplicate" });
		return { id: connection.value.id };
	});

	const refreshConnector = Effect.fn("Connectors.refreshConnector")(function* (userId: string, id: string) {
		yield* refreshTools(yield* mine(userId, id));
		return view(yield* mine(userId, id));
	});

	const changeConnector = Effect.fn("Connectors.changeConnector")(function* (userId: string, id: string, change: ConnectorChange) {
		const connection = yield* mine(userId, id);
		if (change.headers) {
			const headers = yield* headerRecord(change.headers);
			const saved = yield* store.readCredentials(connection).pipe(Effect.catchTags({ UnreadableSecret: () => Effect.succeed<Credentials>({}) }));
			const credentials = { ...saved, headers: Object.keys(headers).length ? headers : undefined };
			// The new headers go with the connection's sign-in, if it has one.
			const target = connection.auth === "oauth" ? yield* clients.targetFor(connection) : { url: connection.url, transport: connection.transport };
			const { tools, serverInfo } = yield* clients.inspect({ ...target, headers: credentials.headers });
			yield* store.saveCredentials(id, credentials, { status: "connected" });
			yield* store.saveTools(id, tools, serverInfo);
			yield* clients.forget(id);
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
		const updated = yield* store.updateConnection(id, userId, { name: change.name?.trim() || undefined, enabled: change.enabled, toolRules });
		if (Option.isNone(updated)) return yield* new ConnectorProblem({ reason: "not-found" });
		return view(updated.value);
	});

	const removeConnector = Effect.fn("Connectors.removeConnector")(function* (userId: string, id: string) {
		yield* clients.forget(id);
		return yield* store.deleteConnection(id, userId);
	});

	// The span's name and attributes are the ones span.ts gave it. Counts only: never a
	// connector's name or a tool's (tracing/privacy.ts).
	const connectorCatalogFor = Effect.fn("connectors.list")(function* (userId: string) {
		const connections = yield* store.connectionsForReply(userId);
		const now = yield* Clock.currentTimeMillis;
		for (const connection of connections) {
			if (connection.status !== "connected") continue;
			if (!connection.toolsCheckedAt || now - connection.toolsCheckedAt.getTime() > STALE_TOOLS_MS) yield* refreshLater(connection);
		}
		// A connector in "error" is tried again every few minutes, so it comes back by itself when its server does.
		for (const connection of yield* store.connectionsToRetry(userId, RETRY_ERROR_MS)) yield* refreshLater(connection);
		const catalog = catalogFrom(connections);
		if (catalog.leftOut) yield* Effect.logWarning(`connectors: ${userId} has ${catalog.tools.length + catalog.leftOut} tools on; the catalog keeps ${catalog.tools.length}.`);
		yield* Tracing.annotate({ "ponder.tools": catalog.tools.length, "ponder.connectors": catalog.connectors.length });
		return catalog;
	});

	const callConnectorTool = Effect.fn("Connectors.callConnectorTool")(function* (connectionId: string, tool: string, input: unknown, userId: string, approved: boolean) {
		const found = yield* store.getConnection(connectionId, userId);
		if (Option.isNone(found)) return "This connector was removed.";
		const connection = found.value;
		if (!connection.enabled) return `${connection.name} is turned off in Settings, Connectors.`;
		if (connection.status === "needs_sign_in") return needsSignIn(connection);
		const info = connection.tools.find((each) => each.name === tool);
		if (!info) return `${connection.name} has no tool named ${toolLabel(tool)} now.`;
		const rule = ruleOf(connection, info);
		if (rule === "off") return `The person turned ${toolLabel(tool)} off in Settings, Connectors.`;
		if (rule === "ask" && !approved) return `${toolLabel(tool)} asks the person first, and they did not approve this call, so it did not run. Tell the person: it will ask them on their next message.`;
		return yield* clients.call(connection, tool, (input ?? {}) as Record<string, unknown>).pipe(
			Effect.tap((called) => (called.isError ? Tracing.annotate({ "ponder.outcome": "tool_error" }) : Effect.void)),
			// The tool's name as its server gives it, never its input or result, nor the connector's name.
			Effect.withSpan("mcp.call_tool", { attributes: { "gen_ai.tool.name": tool } }),
			Effect.tap(() => store.markUsed(connection.id)),
			Effect.map((result) => {
				const { text, isError } = resultText(result);
				return isError ? `${connection.name} answered with an error:\n${text}` : text;
			}),
			// Every failure, and a bug too, is the call's result. Only an interruption stops it.
			Effect.catchCause((cause) => {
				if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
				const error = Cause.squash(cause);
				if (error instanceof NeedsSignIn) return Effect.succeed(needsSignIn(connection));
				return Effect.as(Effect.logWarning(`connectors: ${connection.name} ${tool}: ${describeError(error)}`), `${connection.name} could not run ${tool}: ${describeError(error)}`);
			}),
		);
	});

	return Connectors.of({
		listConnectors,
		addConnector,
		signInAgain,
		completeSignIn,
		refreshConnector,
		changeConnector,
		removeConnector,
		connectorCatalogFor,
		callConnectorTool,
	});
});

export const layer = Layer.effect(Connectors, make);

/**
 * The catalog of these connections, within MAX_CATALOG_TOOLS and MAX_CATALOG_CHARS. The
 * names of the tools that are off count toward the characters too.
 */
export function catalogFrom(connections: Connection[]): CatalogData {
	const signedIn = connections.filter((connection) => connection.status === "connected");
	const off = offTools(signedIn);
	const perConnection = signedIn.map(catalogTools);
	const total = perConnection.reduce((sum, list) => sum + list.length, 0);
	const kept = fairShare(perConnection, MAX_CATALOG_CHARS - JSON.stringify(off).length).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return {
		tools: kept,
		connectors: connections.map((connection) => catalogConnector(connection, kept)),
		leftOut: total - kept.length,
		off,
	};
}

/**
 * The tools the person turned off, by name, up to MAX_OFF_TOOLS and MAX_OFF_CHARS: a
 * server can list many tools, and the catalog is recorded with every reply. A call to an
 * off tool past the limit gets "no tool named".
 */
function offTools(connections: Connection[]): OffTool[] {
	const off: OffTool[] = [];
	let chars = 2;
	for (const connection of connections) {
		for (const tool of connection.tools) {
			if (ruleOf(connection, tool) !== "off") continue;
			const entry = { name: modelToolName(connection.slug, tool.name) };
			chars += JSON.stringify(entry).length + 1;
			if (off.length >= MAX_OFF_TOOLS || chars > MAX_OFF_CHARS) return off;
			off.push(entry);
		}
	}
	return off;
}

/**
 * The tools to keep when there are too many: one from each connection in turn, so a
 * cut takes from the largest connections and leaves none out entirely. Stops at
 * MAX_CATALOG_TOOLS, or when the tools' JSON reaches `maxChars`: what is left of
 * MAX_CATALOG_CHARS after the tools that are off.
 */
function fairShare(perConnection: CatalogTool[][], maxChars: number): CatalogTool[] {
	const kept: CatalogTool[] = [];
	let chars = 0;
	const longest = Math.max(0, ...perConnection.map((list) => list.length));
	for (let index = 0; index < longest; index++) {
		for (const list of perConnection) {
			const tool = list[index];
			if (!tool) continue;
			chars += JSON.stringify(tool).length;
			if (kept.length >= MAX_CATALOG_TOOLS || chars > maxChars) return kept;
			kept.push(tool);
		}
	}
	return kept;
}

function catalogTools(connection: Connection): CatalogTool[] {
	const connector = { slug: connection.slug, name: connection.name, server: serverName(connection) };
	return connection.tools
		.filter((tool) => ruleOf(connection, tool) !== "off")
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map((tool) => ({
			name: modelToolName(connection.slug, tool.name),
			tool: tool.name,
			// Tool lists saved before tools.ts cut titles may hold long ones.
			...(tool.title && { title: tool.title.slice(0, MAX_SERVER_TEXT) }),
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
		...(connection.status === "needs_sign_in" && { unavailable: "sign-in" as const }),
		...(connection.status === "error" && { unavailable: "error" as const }),
	};
}

const serverName = (connection: Connection) => (connection.serverInfo?.title ?? connection.serverInfo?.name)?.slice(0, MAX_SERVER_TEXT);

/** At most this much of a name or title that a server wrote goes into the catalog. */
const MAX_SERVER_TEXT = 200;

/** A tool's name for Ponder's own sentences: not its title, which the server wrote. */
const toolLabel = (tool: string) => (tool.length > 64 ? `${tool.slice(0, 64)}…` : tool);

const needsSignIn = (connection: Connection) =>
	`${connection.name} needs the person to sign in again, in Settings, Connectors. Tell them, and don't try its tools again in this reply.`;
