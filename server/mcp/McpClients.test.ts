/**
 * MCP clients as resources: the pool opens a connection's client once, closes it after two
 * idle minutes, after a failed call, when it is forgotten (once its calls end) and when the
 * service's scope closes. The timeouts are Effect's, so time is moved with TestClock.
 *
 * The MCP server is the outside system: a fake McpTransport stands in for @ai-sdk/mcp's
 * client. The database is a small in-memory store of connection statuses. The OAuth
 * service is the real one.
 */
import { UnauthorizedError } from "@ai-sdk/mcp";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as PonderConfig from "../config.ts";
import * as NetGuard from "../net/NetGuard.ts";
import * as ConnectorOAuth from "./ConnectorOAuth.ts";
import * as ConnectorStore from "./ConnectorStore.ts";
import type { Connection } from "./ConnectorStore.ts";
import { ConnectorFailed, ConnectorProblem, describeError, NeedsSignIn } from "./errors.ts";
import * as McpClients from "./McpClients.ts";

type Call = (signal: AbortSignal) => Promise<unknown>;

/** A fake MCP server: what each call answers, and every client it opened and closed. */
function fakeServer() {
	const server = {
		opened: 0,
		closed: 0,
		/** The signal of the last connect and the last call, to see that a timeout aborts them. */
		connectSignal: undefined as AbortSignal | undefined,
		callSignal: undefined as AbortSignal | undefined,
		/** Connecting never answers: it waits until it is aborted. */
		hangOnConnect: false,
		answer: (async () => ({ content: [{ type: "text", text: "ok" }] })) as Call,
	};
	const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
	const transport = McpClients.McpTransport.of({
		connect: async (_target, signal) => {
			server.connectSignal = signal;
			if (server.hangOnConnect) return hang(signal);
			server.opened++;
			let open = true;
			return {
				serverInfo: { name: "fake", version: "1.0.0" },
				instructions: undefined,
				listTools: async () => ({ tools: [] }),
				callTool: async ({ options }) => {
					if (!open) throw new Error("closed client used");
					server.callSignal = options?.signal;
					return (await server.answer(options!.signal!)) as never;
				},
				close: async () => {
					open = false;
					server.closed++;
				},
			} as McpClients.McpSession;
		},
	});
	return { server, transport: Layer.succeed(McpClients.McpTransport, transport) };
}

/** The statuses saved, by connection id. Only what the clients use of the store. */
function fakeStore() {
	const statuses = new Map<string, { status: string; lastError: string | null }>();
	const service = {
		readCredentials: (connection: Pick<Connection, "sealed">) =>
			Effect.succeed(connection.sealed ? { tokens: { access_token: "token", token_type: "Bearer" } } : {}),
		setStatus: (id: string, status: string, lastError: string | null = null) => Effect.sync(() => void statuses.set(id, { status, lastError })),
		saveCredentials: () => Effect.void,
	} as unknown as ConnectorStore.ConnectorStore["Service"];
	return { statuses, layer: Layer.succeed(ConnectorStore.ConnectorStore, ConnectorStore.ConnectorStore.of(service)) };
}

function connection(id: string, auth: Connection["auth"] = "none"): Connection {
	return {
		id,
		userId: "someone",
		name: "Fake",
		slug: "fake",
		url: "https://mcp.example.com/mcp",
		transport: "http",
		auth,
		status: "connected",
		enabled: true,
		headerNames: [],
		oauthClientId: null,
		expiresAt: null,
		serverInfo: null,
		tools: [],
		toolsCheckedAt: null,
		toolRules: {},
		lastError: null,
		lastUsedAt: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		// For OAuth: credentials with a token that does not expire (fakeStore).
		sealed: auth === "oauth" ? "sealed" : null,
	};
}

function setup() {
	const { server, transport } = fakeServer();
	const store = fakeStore();
	const layer = McpClients.layer.pipe(
		Layer.provide(transport),
		Layer.provide(ConnectorOAuth.layer),
		Layer.provideMerge(store.layer),
		Layer.provide(NetGuard.layer),
		Layer.provide(PonderConfig.layerFromEnv({})),
	);
	return { server, statuses: store.statuses, layer };
}

/** A promise that settles when the fake server gets a call: the test waits for it, with no polling. */
function latch() {
	let enter: () => void = () => undefined;
	const entered = new Promise<void>((resolve) => (enter = resolve));
	return { entered, enter };
}

const call = (target: Connection) => McpClients.McpClients.use((clients) => clients.call(target, "echo", {}));

describe("McpClients", () => {
	it.effect("opens one client for a connection's calls, and closes it after two idle minutes", () => {
		const { server, layer } = setup();
		return Effect.gen(function* () {
			const target = connection("a");
			yield* call(target);
			yield* call(target);
			assert.strictEqual(server.opened, 1);
			yield* TestClock.adjust("119 seconds");
			assert.strictEqual(server.closed, 0);
			yield* call(target);
			// The two minutes start again at the last call.
			yield* TestClock.adjust("119 seconds");
			assert.strictEqual(server.closed, 0);
			yield* TestClock.adjust("1 second");
			assert.strictEqual(server.closed, 1);
			yield* call(target);
			assert.strictEqual(server.opened, 2);
		}).pipe(Effect.provide(layer));
	});

	it.effect("closes every client when its scope closes", () => {
		const { server, layer } = setup();
		return Effect.gen(function* () {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(layer);
					yield* Effect.provideContext(Effect.all([call(connection("a")), call(connection("b"))]), context);
					assert.strictEqual(server.opened, 2);
					assert.strictEqual(server.closed, 0);
				}),
			);
			assert.strictEqual(server.closed, 2);
		});
	});

	it.effect("closes the client after a failed call, and the next call connects again", () => {
		const { server, layer } = setup();
		return Effect.gen(function* () {
			const target = connection("a");
			server.answer = async () => {
				throw new Error("fetch failed");
			};
			const failed = yield* Effect.flip(call(target));
			assert.instanceOf(failed, ConnectorFailed);
			assert.strictEqual(describeError(failed), "Could not connect to the server.");
			assert.strictEqual(server.closed, 1);
			server.answer = async () => ({ content: [] });
			yield* call(target);
			assert.strictEqual(server.opened, 2);
		}).pipe(Effect.provide(layer));
	});

	it.effect("closes a forgotten client only when the call that uses it ends", () => {
		const { server, layer } = setup();
		return Effect.gen(function* () {
			let finish: (value: unknown) => void = () => undefined;
			const { entered, enter } = latch();
			server.answer = () => {
				enter();
				return new Promise((resolve) => (finish = resolve));
			};
			const running = yield* Effect.forkChild(call(connection("a")));
			yield* Effect.promise(() => entered);
			yield* McpClients.McpClients.use((clients) => clients.forget("a"));
			assert.strictEqual(server.closed, 0);
			finish({ content: [] });
			yield* Fiber.join(running);
			assert.strictEqual(server.closed, 1);
		}).pipe(Effect.provide(layer));
	});

	it.effect("an error on a client that was replaced leaves the newer client alone", () => {
		const { server, layer } = setup();
		return Effect.gen(function* () {
			let fail: (error: Error) => void = () => undefined;
			const { entered, enter } = latch();
			server.answer = () => {
				enter();
				return new Promise((_, reject) => (fail = reject));
			};
			const old = yield* Effect.forkChild(Effect.flip(call(connection("a"))));
			yield* Effect.promise(() => entered);
			// A new sign-in takes the old client out; the next call opens a new one.
			yield* McpClients.McpClients.use((clients) => clients.forget("a"));
			server.answer = async () => ({ content: [] });
			yield* call(connection("a"));
			fail(new Error("socket hang up"));
			yield* Fiber.join(old);
			assert.strictEqual(server.opened, 2);
			assert.strictEqual(server.closed, 1);
			yield* call(connection("a"));
			assert.strictEqual(server.opened, 2);
		}).pipe(Effect.provide(layer));
	});

	it.effect("gives up connecting after 15 seconds, and aborts the connection", () => {
		const { server, layer } = setup();
		return Effect.gen(function* () {
			server.hangOnConnect = true;
			const connecting = yield* Effect.forkChild(Effect.flip(call(connection("a"))));
			yield* TestClock.adjust("14 seconds");
			assert.isFalse(server.connectSignal!.aborted);
			yield* TestClock.adjust("1 second");
			const failed = yield* Fiber.join(connecting);
			assert.instanceOf(failed, ConnectorFailed);
			assert.isTrue(failed instanceof ConnectorFailed && failed.operation === "connect" && Cause.isTimeoutError(failed.cause));
			assert.strictEqual(describeError(failed), "The server took too long to answer.");
			assert.isTrue(server.connectSignal!.aborted);
		}).pipe(Effect.provide(layer));
	});

	it.effect("gives up on a call after 60 seconds, aborts it, and closes the client", () => {
		const { server, layer } = setup();
		return Effect.gen(function* () {
			server.answer = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
			const calling = yield* Effect.forkChild(Effect.exit(call(connection("a"))));
			yield* TestClock.adjust("59 seconds");
			assert.isFalse(server.callSignal!.aborted);
			yield* TestClock.adjust("1 second");
			const exit = yield* Fiber.join(calling);
			assert.isTrue(Exit.isFailure(exit));
			assert.isTrue(server.callSignal!.aborted);
			assert.strictEqual(server.closed, 1);
		}).pipe(Effect.provide(layer));
	});

	it.effect("a refused key (401) is a problem the person can fix, saved as the connection's error", () => {
		const { server, statuses, layer } = setup();
		return Effect.gen(function* () {
			server.answer = async () => {
				throw new Error("HTTP 401: Unauthorized");
			};
			const failed = yield* Effect.flip(call(connection("key", "headers")));
			assert.instanceOf(failed, ConnectorProblem);
			assert.strictEqual(failed.message, "The server refused the API key. Enter a new key.");
			assert.deepStrictEqual(statuses.get("key"), { status: "error", lastError: "The server refused the API key. Enter a new key." });
		}).pipe(Effect.provide(layer));
	});

	it.effect("a refused sign-in (401) needs a new sign-in", () => {
		const { server, statuses, layer } = setup();
		return Effect.gen(function* () {
			server.answer = async () => {
				throw new UnauthorizedError();
			};
			const failed = yield* Effect.flip(call(connection("oauth", "oauth")));
			assert.instanceOf(failed, NeedsSignIn);
			assert.deepStrictEqual(statuses.get("oauth"), { status: "needs_sign_in", lastError: "The server refused the sign-in. Sign in again." });
		}).pipe(Effect.provide(layer));
	});
});
