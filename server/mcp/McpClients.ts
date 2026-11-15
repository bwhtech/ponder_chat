import { createMCPClient, type CallToolResult, type MCPClient } from "@ai-sdk/mcp";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import type * as Scope from "effect/Scope";
import type { SqlError } from "effect/sql/SqlError";
import * as NetGuard from "../net/NetGuard.ts";
import { withPeer } from "../tracing/http.ts";
import * as ConnectorOAuth from "./ConnectorOAuth.ts";
import * as ConnectorStore from "./ConnectorStore.ts";
import type { Connection, ServerInfo, ToolInfo, Transport } from "./ConnectorStore.ts";
import { ConnectorFailed, ConnectorProblem, describeError, isUnauthorized, NeedsSignIn, sdkFailure } from "./errors.ts";
import { toToolInfo } from "./tools.ts";

/**
 * MCP clients. With ConnectorOAuth.ts, the only code that uses @ai-sdk/mcp. Every request
 * goes through the guarded fetch (net/NetGuard.ts), so a server can't reach a private
 * network, and transports refuse redirects.
 *
 * A client is a resource: opened in a Scope and closed with it (Effect.acquireRelease).
 * The timeouts are Effect's: interrupting a request aborts it, through the signal the SDK takes.
 */
const CONNECT_TIMEOUT = Duration.seconds(15);
const CLOSE_TIMEOUT = Duration.seconds(5);
const LIST_TIMEOUT = Duration.seconds(20);
const CALL_TIMEOUT = Duration.seconds(60);
const IDLE = Duration.minutes(2);
const MAX_TOOLS = 200;

export type Target = { url: string; transport: Transport; headers?: Record<string, string>; oauth?: ConnectorOAuth.OAuthProvider };

/** The part of @ai-sdk/mcp's client that Ponder uses. */
export type McpSession = Pick<MCPClient, "listTools" | "callTool" | "close" | "serverInfo" | "instructions">;

export type Listed = { tools: ToolInfo[]; serverInfo: ServerInfo };

type OpenError = ConnectorFailed | ConnectorProblem | NeedsSignIn;

/**
 * The way to an MCP server: @ai-sdk/mcp's client, on the guarded fetch. A test gives a
 * fake one, in place of a real server.
 */
export class McpTransport extends Context.Service<
	McpTransport,
	{
		/** Connects and initializes a client. Aborting the signal stops it. */
		readonly connect: (target: Target, signal: AbortSignal) => Promise<McpSession>;
	}
>()("ponder/mcp/McpTransport") {}

export const transportLayer = Layer.effect(
	McpTransport,
	Effect.gen(function* () {
		const guard = yield* NetGuard.NetGuard;
		// The SDK reports errors it does not throw through a callback: logged on the runtime's logger.
		const log = Effect.runForkWith(yield* Effect.context<never>());
		return McpTransport.of({
			connect: (target, signal) =>
				createMCPClient({
					transport: { type: target.transport, url: target.url, headers: target.headers, authProvider: target.oauth, fetch: guard.fetch, redirect: "error" },
					clientName: "Ponder Chat",
					version: "1.0.0",
					initializationOptions: { signal },
					// A refused sign-in or key is also thrown, and saved as the connection's status.
					onUncaughtError: (error) => {
						if (!/\b401\b|Unauthorized/i.test(String(error))) log(Effect.logWarning(`connectors: ${new URL(target.url).host}: ${describeError(error)}`));
					},
				}),
		});
	}),
);

/**
 * A key of the pool: the connection, and how many times its client was taken out. A client
 * taken out (after an error, a new sign-in, new headers) keeps its old key, so a late error
 * on it can't take out the newer client. The connection is what a new client opens with;
 * it is not part of the key.
 */
class ClientKey implements Equal.Equal {
	constructor(
		readonly id: string,
		readonly generation: number,
		readonly connection?: Connection,
	) {}

	[Equal.symbol](that: Equal.Equal): boolean {
		return that instanceof ClientKey && that.id === this.id && that.generation === this.generation;
	}

	[Hash.symbol](): number {
		return Hash.string(`${this.id}:${this.generation}`);
	}
}

export class McpClients extends Context.Service<
	McpClients,
	{
		/** A client for the target, open until the scope closes. */
		readonly open: (target: Target) => Effect.Effect<McpSession, OpenError, Scope.Scope>;
		/** The server's tools as plain data, every page of them, and what it says about itself. */
		readonly listTools: (client: McpSession) => Effect.Effect<Listed, OpenError>;
		/** Connects once, lists the tools and closes: for a new connector, a new key, and Refresh tools. */
		readonly inspect: (target: Target) => Effect.Effect<Listed, OpenError>;
		/** The target for a saved connection, with a token refreshed when it is about to expire. */
		readonly targetFor: (connection: Connection) => Effect.Effect<Target, OpenError | SqlError>;
		/**
		 * Calls the tool on the connection's pooled client. One client for each connection is
		 * kept for 2 minutes after its last use, so a reply with several calls connects once.
		 * A client is never closed while a call uses it. After any error the client leaves the
		 * pool, and the next call connects again. A refused sign-in marks the connection
		 * "needs_sign_in" and fails with NeedsSignIn.
		 */
		readonly call: (connection: Connection, tool: string, input: Record<string, unknown>) => Effect.Effect<CallToolResult, OpenError | SqlError>;
		/**
		 * Takes the connection's client out of the pool: after a new sign-in, new headers, or
		 * removal. It closes now, or when the calls using it end.
		 */
		readonly forget: (id: string) => Effect.Effect<void>;
	}
>()("ponder/mcp/McpClients") {}

const make = Effect.gen(function* () {
	const transport = yield* McpTransport;
	const store = yield* ConnectorStore.ConnectorStore;
	const oauth = yield* ConnectorOAuth.ConnectorOAuth;

	/** One request to the server, within `limit`. Its HTTP requests are marked as MCP, and their host left out (tracing/http.ts). */
	const request = <A>(operation: ConnectorFailed["operation"], send: (signal: AbortSignal) => Promise<A>, limit: Duration.Duration) =>
		Effect.tryPromise({ try: (signal) => withPeer("mcp", () => send(signal)), catch: sdkFailure(operation) }).pipe(
			Effect.timeout(limit),
			Effect.catchTags({ TimeoutError: (cause) => Effect.fail(new ConnectorFailed({ operation, cause })) }),
		);

	const open = (target: Target) =>
		Effect.acquireRelease(
			request("connect", (signal) => transport.connect(target, signal), CONNECT_TIMEOUT),
			// The SDK's close() can send a DELETE with no signal. A server that stalls it holds
			// up the step or the removal for CLOSE_TIMEOUT at most; the release is
			// uninterruptible, so the wait itself is made interruptible for the timeout.
			(client) => Effect.tryPromise(() => client.close()).pipe(Effect.interruptible, Effect.timeout(CLOSE_TIMEOUT), Effect.ignore),
			// The connection can be stopped while it opens: its timeout, or the caller.
			{ interruptible: true },
		);

	const listTools = Effect.fn("McpClients.listTools")(function* (client: McpSession) {
		const tools: ToolInfo[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 20 && tools.length < MAX_TOOLS; page++) {
			const params = cursor ? { cursor } : undefined;
			const result = yield* request("list", (signal) => client.listTools({ params, options: { signal } }), LIST_TIMEOUT);
			tools.push(...result.tools.map(toToolInfo));
			cursor = result.nextCursor;
			if (!cursor) break;
		}
		const info = client.serverInfo;
		return {
			tools: tools.slice(0, MAX_TOOLS),
			serverInfo: { name: info?.name, title: info?.title, version: info?.version, instructions: client.instructions?.slice(0, 4_000) },
		};
	});

	const inspect = Effect.fn("McpClients.inspect")(function* (target: Target) {
		return yield* Effect.scoped(Effect.flatMap(open(target), listTools));
	});

	const targetFor = Effect.fn("McpClients.targetFor")(function* (connection: Connection) {
		const saved = yield* store.readCredentials(connection).pipe(
			Effect.catchTags({
				UnreadableSecret: () =>
					store
						.setStatus(connection.id, "needs_sign_in", "Ponder can't read this connector's sign-in any more. Sign in again.")
						.pipe(Effect.andThen(Effect.fail(new NeedsSignIn({ reason: "unreadable" })))),
			}),
		);
		const credentials = yield* oauth.freshCredentials(connection, saved).pipe(
			Effect.catchTags({ NeedsSignIn: (error) => store.setStatus(connection.id, "needs_sign_in", "The sign-in ended. Sign in again.").pipe(Effect.andThen(Effect.fail(error))) }),
		);
		return {
			url: connection.url,
			transport: connection.transport,
			headers: credentials.headers,
			oauth: connection.auth === "oauth" ? oauth.background(connection, credentials) : undefined,
		} satisfies Target;
	});

	// The pool: closed with the service, which closes every client in it.
	const pool = yield* RcMap.make({
		lookup: (key: ClientKey) => Effect.flatMap(targetFor(key.connection!), open),
		idleTimeToLive: IDLE,
	});
	const generations = new Map<string, number>();
	const keyFor = (id: string, connection?: Connection) => new ClientKey(id, generations.get(id) ?? 0, connection);

	/** Takes this client out of the pool. A newer client of the same connection stays. */
	const retire = (key: ClientKey) =>
		Effect.suspend(() => {
			if ((generations.get(key.id) ?? 0) === key.generation) generations.set(key.id, key.generation + 1);
			return RcMap.invalidate(pool, key);
		});

	const forget = (id: string) => Effect.suspend(() => retire(keyFor(id)));

	/** The server refused the sign-in or the key: saved as the connection's status. */
	const refused = (connection: Connection): Effect.Effect<never, NeedsSignIn | ConnectorProblem | SqlError> => {
		if (connection.auth === "oauth")
			return store.setStatus(connection.id, "needs_sign_in", "The server refused the sign-in. Sign in again.").pipe(Effect.andThen(Effect.fail(new NeedsSignIn())));
		const reason = connection.auth === "headers" ? "key-refused" : "asks-sign-in";
		const problem = new ConnectorProblem({ reason });
		return store.setStatus(connection.id, "error", problem.message).pipe(Effect.andThen(Effect.fail(problem)));
	};

	const call = Effect.fn("McpClients.call")(function* (connection: Connection, tool: string, input: Record<string, unknown>) {
		const key = keyFor(connection.id, connection);
		return yield* Effect.scoped(
			Effect.flatMap(RcMap.get(pool, key), (client) => request("call", (signal) => client.callTool({ name: tool, arguments: input, options: { signal } }), CALL_TIMEOUT)),
		).pipe(
			Effect.onError(() => retire(key)),
			Effect.catchIf(isUnauthorized, () => refused(connection)),
		);
	});

	return McpClients.of({ open, listTools, inspect, targetFor, call, forget });
});

export const layer = Layer.effect(McpClients, make);
