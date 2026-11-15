import { randomBytes } from "node:crypto";
import {
	auth,
	type OAuthAuthorizationServerInformation,
	type OAuthClientInformation,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthTokens,
} from "@ai-sdk/mcp";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as PonderConfig from "../config.ts";
import { originOf } from "../hosts.ts";
import * as NetGuard from "../net/NetGuard.ts";
import type { UnreadableSecret } from "../secrets/Secrets.ts";
import { withPeer } from "../tracing/http.ts";
import * as ConnectorStore from "./ConnectorStore.ts";
import { tokenExpiry, type Connection, type Credentials, type SignIn, type SignInSecret } from "./ConnectorStore.ts";
import { ConnectorFailed, ConnectorProblem, describeError, NeedsSignIn, sdkFailure } from "./errors.ts";

/**
 * OAuth for connectors. The AI SDK runs the flow the MCP spec asks for: it finds the
 * authorization server (RFC 9728, RFC 8414), registers Ponder when needed (RFC 7591),
 * uses PKCE, checks the state and the issuer, and pins the authorization server to the
 * credentials. This file keeps what the flow saves, in mcp_connections and mcp_sign_ins.
 *
 * The SDK calls Ponder back through its OAuthClientProvider: plain functions, some of
 * them sync getters. So the provider (OAuthProvider below) is built inside the service,
 * with what it needs already read: the hosts, the clock, and a runner for the effects it
 * starts (saving credentials, reading an authorization server's metadata), on the
 * service's own context.
 */
export const CALLBACK_PATH = "/oauth/mcp/callback";

/** The callback on every host Ponder answers on, so one registration works on all of them. */
const callbackUrls = (hosts: ReadonlyArray<string>) => hosts.map((host) => `${originOf(host)}${CALLBACK_PATH}`);

const REFRESH_EARLY_MS = 60_000;
const DISCOVERY_TIMEOUT = "10 seconds";

type Options = {
	redirectUrl: string;
	/** The OAuth state of a sign-in. Absent when a token is only refreshed. */
	state?: string;
	verifier?: string;
	/** Saves the credentials when they change outside a sign-in (a refresh, refused tokens). */
	persist?: (credentials: Credentials) => Promise<void>;
};

/** What the provider needs from the service, read when the service is built. */
type Edge = {
	/** The hosts Ponder answers on (PONDER_HOSTS). */
	hosts: ReadonlyArray<string>;
	privateNetworksAllowed: boolean;
	now: () => number;
	/** RFC 8414 metadata of an authorization server, through the guarded fetch. */
	discover: (server: URL) => Promise<OAuthAuthorizationServerInformation | undefined>;
};

/** The SDK's OAuthClientProvider, on one connection's credentials. */
export class OAuthProvider implements OAuthClientProvider {
	authorizationUrl: URL | undefined;
	private discovered: OAuthAuthorizationServerInformation | undefined;

	constructor(
		readonly credentials: Credentials,
		private options: Options,
		private edge: Edge,
	) {}

	get redirectUrl() {
		return this.options.redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Ponder Chat",
			client_uri: originOf(this.edge.hosts[0]!),
			redirect_uris: callbackUrls(this.edge.hosts),
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	get verifier() {
		return this.options.verifier;
	}

	state() {
		return this.options.state ?? randomBytes(32).toString("base64url");
	}

	storedState() {
		return this.options.state;
	}

	tokens() {
		return this.credentials.tokens;
	}

	async saveTokens(tokens: OAuthTokens) {
		// expires_at: when the token expires, so a refresh can happen before a call fails.
		const expiresAt = typeof tokens.expires_in === "number" ? this.edge.now() + tokens.expires_in * 1000 : undefined;
		this.credentials.tokens = { ...tokens, ...(expiresAt && { expires_at: expiresAt }) } as OAuthTokens;
		await this.options.persist?.(this.credentials);
	}

	redirectToAuthorization(url: URL) {
		this.authorizationUrl = url;
	}

	saveCodeVerifier(verifier: string) {
		this.options.verifier = verifier;
	}

	codeVerifier() {
		if (!this.options.verifier) throw new ConnectorProblem({ reason: "no-verifier" });
		return this.options.verifier;
	}

	clientInformation() {
		return this.credentials.client;
	}

	isClientInformationDynamicallyRegistered() {
		return this.credentials.clientIsDynamic === true;
	}

	async saveClientInformation(client: OAuthClientInformation) {
		this.credentials.client = client;
		this.credentials.clientIsDynamic = true;
		await this.options.persist?.(this.credentials);
	}

	authorizationServerInformation() {
		return this.credentials.authServer ?? this.discovered;
	}

	saveAuthorizationServerInformation(information: OAuthAuthorizationServerInformation) {
		this.credentials.authServer = information;
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier", context?: { tokens: OAuthTokens }) {
		if ((scope === "all" || scope === "client") && this.credentials.clientIsDynamic) delete this.credentials.client;
		const sameTokens = !context || context.tokens.access_token === this.credentials.tokens?.access_token;
		if ((scope === "all" || scope === "tokens") && sameTokens) delete this.credentials.tokens;
		if (scope === "all") delete this.credentials.authServer;
		if (scope !== "verifier") await this.options.persist?.(this.credentials);
	}

	/**
	 * The authorization server comes from the MCP server's metadata, so it must be public
	 * too. A person's own OAuth app with a secret must be bound to its authorization server
	 * before the first sign-in (the SDK refuses it otherwise), so its metadata is read here.
	 */
	async validateAuthorizationServerURL(_serverUrl: string | URL, authorizationServerUrl: string | URL) {
		const url = new URL(authorizationServerUrl);
		if (!this.edge.privateNetworksAllowed) {
			if (url.protocol !== "https:") throw new ConnectorProblem({ reason: "sign-in-not-https" });
			NetGuard.assertPublicHost(url);
		}
		const client = this.credentials.client;
		if (client?.client_secret && !client.issuer && !this.authorizationServerInformation()) this.discovered = await this.edge.discover(url);
	}
}

/** The fields of an authorization server's metadata that Ponder reads. Anything else is left alone. */
const ServerMetadata = Schema.Struct({ issuer: Schema.optional(Schema.String), token_endpoint: Schema.optional(Schema.String) });
const decodeMetadata = Schema.decodeUnknownOption(ServerMetadata);

export type StartSignIn = {
	userId: string;
	origin: string;
	url: string;
	connectionId: string | null;
	credentials: Credentials;
	draft?: SignInSecret["draft"];
};

export type FinishSignIn = {
	userId: string;
	state: string;
	code: string;
	issuer?: string;
	/** The MCP server's URL for the sign-in: its draft's, or its connection's. Undefined when the connection is gone. */
	url: (signIn: SignIn) => Effect.Effect<string | undefined, SqlError>;
};

type SignInError = ConnectorProblem | ConnectorFailed | NeedsSignIn | SqlError | UnreadableSecret;

export class ConnectorOAuth extends Context.Service<
	ConnectorOAuth,
	{
		/**
		 * Starts a sign-in: finds the authorization server, registers Ponder if needed, and
		 * returns the URL where the person signs in. The verifier and the hash of the state wait
		 * in mcp_sign_ins for 10 minutes. `origin` is the host the person uses, so the callback
		 * gets their session cookie.
		 */
		readonly startSignIn: (input: StartSignIn) => Effect.Effect<string, SignInError>;
		/** Ends a sign-in with the code from the callback. Gives the credentials with their tokens. */
		readonly finishSignIn: (
			input: FinishSignIn,
		) => Effect.Effect<{ connectionId: string | null; draft: SignInSecret["draft"]; credentials: Credentials }, SignInError>;
		/** The provider for calls outside a sign-in: it saves refreshed or refused tokens to the connection. */
		readonly background: (connection: Pick<Connection, "id">, credentials: Credentials) => OAuthProvider;
		/** A provider that saves nothing, on these credentials: for the first listing of a new connection's tools. */
		readonly unsaved: (credentials: Credentials, redirectUrl: string) => OAuthProvider;
		/**
		 * Credentials with a token that is good for at least another minute. Refreshes one
		 * connection one time at a time: two tool calls at once must not both use a refresh token
		 * that the server rotates. (One process runs Ponder, so a lock in memory is enough.)
		 */
		readonly freshCredentials: (connection: Connection, credentials: Credentials) => Effect.Effect<Credentials, NeedsSignIn | ConnectorProblem | ConnectorFailed>;
	}
>()("ponder/mcp/ConnectorOAuth") {}

const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const guard = yield* NetGuard.NetGuard;
	const store = yield* ConnectorStore.ConnectorStore;
	const clock = yield* Clock.Clock;
	const run = Effect.runPromiseWith(yield* Effect.context<never>());

	/** RFC 8414 metadata, then OpenID Connect discovery, as the SDK looks for them. */
	const discoverAuthorizationServer = Effect.fn("ConnectorOAuth.discoverAuthorizationServer")(function* (server: URL) {
		const path = server.pathname === "/" ? "" : server.pathname.replace(/\/$/, "");
		const candidates = [
			`/.well-known/oauth-authorization-server${path}`,
			`/.well-known/openid-configuration${path}`,
			...(path ? [`${path}/.well-known/openid-configuration`] : []),
		];
		let failure: unknown;
		let answered = false;
		for (const candidate of candidates) {
			// The timeout covers the answer's body too, as the request's AbortSignal did.
			const fetched = yield* Effect.tryPromise({
				try: async (signal) => {
					const response = await guard.fetch(new URL(candidate, server.origin), { headers: { accept: "application/json" }, signal });
					if (!response.ok) {
						await response.body?.cancel();
						return Option.none<unknown>();
					}
					return Option.some<unknown>(await response.json().catch(() => undefined));
				},
				catch: (error) => error,
			}).pipe(Effect.timeout(DISCOVERY_TIMEOUT), Effect.result);
			if (Result.isFailure(fetched)) {
				failure = fetched.failure;
				continue;
			}
			answered = true;
			const metadata = Option.flatMap(fetched.success, decodeMetadata);
			if (Option.isNone(metadata) || !metadata.value.issuer || !metadata.value.token_endpoint) continue;
			return { issuer: metadata.value.issuer, authorizationServerUrl: server.toString(), tokenEndpoint: metadata.value.token_endpoint };
		}
		// Nothing answered (a timeout, the network): not the same as a server with no metadata.
		if (!answered) {
			yield* Effect.logWarning(`connectors: no metadata address of the authorization server ${server.host} answered:`, describeError(failure));
			return yield* new ConnectorProblem({ reason: "sign-in-unreachable" });
		}
		return undefined;
	});

	const edge: Edge = {
		hosts: config.hosts,
		privateNetworksAllowed: guard.privateNetworksAllowed,
		now: () => clock.currentTimeMillisUnsafe(),
		discover: (server) => run(discoverAuthorizationServer(server)),
	};

	/**
	 * The SDK's auth(), through the guarded fetch. Interrupting it aborts its requests. Its
	 * HTTP requests are marked as MCP, and their host left out (tracing/http.ts).
	 */
	const authorize = (operation: "sign-in" | "refresh", provider: OAuthProvider, options: Omit<Parameters<typeof auth>[1], "fetchFn">) =>
		Effect.tryPromise({
			try: (signal) =>
				withPeer("mcp", () =>
					auth(provider, {
						...options,
						fetchFn: (input, init) => guard.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
					}),
				),
			catch: sdkFailure(operation),
		});

	const startSignIn = Effect.fn("ConnectorOAuth.startSignIn")(function* (input: StartSignIn) {
		const state = randomBytes(32).toString("base64url");
		const redirectUrl = `${input.origin}${CALLBACK_PATH}`;
		// A new sign-in starts without tokens, so the SDK asks for a new authorization instead of refreshing.
		const provider = new OAuthProvider({ ...input.credentials, tokens: undefined }, { redirectUrl, state }, edge);
		const result = yield* authorize("sign-in", provider, { serverUrl: input.url });
		if (result !== "REDIRECT" || !provider.authorizationUrl) return yield* new ConnectorProblem({ reason: "no-redirect" });
		yield* store.saveSignIn(state, input.userId, input.connectionId, {
			verifier: provider.verifier,
			redirectUrl,
			credentials: provider.credentials,
			draft: input.draft,
		});
		return provider.authorizationUrl.toString();
	});

	const finishSignIn = Effect.fn("ConnectorOAuth.finishSignIn")(function* (input: FinishSignIn) {
		const signIn = yield* store.takeSignIn(input.state, input.userId);
		if (Option.isNone(signIn)) return yield* new ConnectorProblem({ reason: "sign-in-expired" });
		const url = yield* input.url(signIn.value);
		if (!url) return yield* new ConnectorProblem({ reason: "removed-during-sign-in" });
		const { secret } = signIn.value;
		const provider = new OAuthProvider(secret.credentials, { redirectUrl: secret.redirectUrl, state: input.state, verifier: secret.verifier }, edge);
		yield* authorize("sign-in", provider, { serverUrl: url, authorizationCode: input.code, callbackState: input.state, callbackIssuer: input.issuer });
		if (!provider.credentials.tokens?.access_token) return yield* new ConnectorProblem({ reason: "no-token" });
		return { connectionId: signIn.value.connectionId, draft: secret.draft, credentials: provider.credentials };
	});

	const background = (connection: Pick<Connection, "id">, credentials: Credentials) =>
		new OAuthProvider(
			credentials,
			{
				redirectUrl: callbackUrls(config.hosts)[0]!,
				persist: (changed) => {
					const signedOut = !changed.tokens?.access_token;
					return run(store.saveCredentials(connection.id, changed, signedOut ? { status: "needs_sign_in", lastError: "The sign-in ended. Sign in again." } : undefined));
				},
			},
			edge,
		);

	const unsaved = (credentials: Credentials, redirectUrl: string) => new OAuthProvider(credentials, { redirectUrl }, edge);

	// The refreshes running now, one for each connection. They run in the service's scope, so a
	// call that stops waiting does not stop the refresh that another call waits for too.
	const refreshing = yield* FiberMap.make<string, Credentials, NeedsSignIn | ConnectorProblem | ConnectorFailed>();

	const refresh = Effect.fn("ConnectorOAuth.refresh")(function* (connection: Connection, credentials: Credentials) {
		const provider = background(connection, credentials);
		const result = yield* authorize("refresh", provider, { serverUrl: connection.url });
		if (result !== "AUTHORIZED" || !provider.credentials.tokens?.access_token) return yield* new NeedsSignIn();
		return provider.credentials;
	});

	const freshCredentials = Effect.fn("ConnectorOAuth.freshCredentials")(function* (connection: Connection, credentials: Credentials) {
		if (connection.auth !== "oauth") return credentials;
		if (!credentials.tokens?.access_token) return yield* new NeedsSignIn();
		const expiresAt = tokenExpiry(credentials);
		if (!expiresAt || expiresAt.getTime() - (yield* Clock.currentTimeMillis) > REFRESH_EARLY_MS) return credentials;
		if (!credentials.tokens.refresh_token) return yield* new NeedsSignIn();
		const running = yield* FiberMap.get(refreshing, connection.id);
		const fiber = Option.isSome(running) ? running.value : yield* FiberMap.run(refreshing, connection.id, refresh(connection, credentials));
		return yield* Fiber.join(fiber);
	});

	return ConnectorOAuth.of({ startSignIn, finishSignIn, background, unsaved, freshCredentials });
});

export const layer = Layer.effect(ConnectorOAuth, make);
