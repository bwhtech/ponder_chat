import { randomBytes } from "node:crypto";
import {
	auth,
	type OAuthAuthorizationServerInformation,
	type OAuthClientInformation,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthTokens,
} from "@ai-sdk/mcp";
import * as PonderConfig from "../config.ts";
import { originOf } from "../hosts.ts";
import * as NetGuard from "../net/NetGuard.ts";
import { runPromise } from "../runtime/runtime.ts";
import { ConnectorProblem, describeError, NeedsSignIn } from "./errors.ts";
import { saveCredentials, saveSignIn, takeSignIn, tokenExpiry, type Connection, type Credentials, type SignInSecret } from "./store.ts";

/**
 * OAuth for connectors. The AI SDK runs the flow the MCP spec asks for: it finds the
 * authorization server (RFC 9728, RFC 8414), registers Ponder when needed (RFC 7591),
 * uses PKCE, checks the state and the issuer, and pins the authorization server to the
 * credentials. This file keeps what the flow saves, in mcp_connections and mcp_sign_ins.
 */
export const CALLBACK_PATH = "/oauth/mcp/callback";

/**
 * The hosts Ponder answers on (PONDER_HOSTS), for the sync getters of the SDK's provider
 * below: read from the environment, as the runtime's config is (config.ts, readNow).
 */
const hosts = () => PonderConfig.readNow().hosts;

/** The callback on every host Ponder answers on, so one registration works on all of them. */
const callbackUrls = () => hosts().map((host) => `${originOf(host)}${CALLBACK_PATH}`);

/** The guarded fetch (net/NetGuard.ts): public addresses only. */
const guardedFetch = async () => (await runPromise(NetGuard.NetGuard)).fetch;

type Options = {
	redirectUrl: string;
	/** The OAuth state of a sign-in. Absent when a token is only refreshed. */
	state?: string;
	verifier?: string;
	/** Saves the credentials when they change outside a sign-in (a refresh, refused tokens). */
	persist?: (credentials: Credentials) => Promise<void>;
};

/** The SDK's OAuthClientProvider, on one connection's credentials. */
export class ConnectorOAuth implements OAuthClientProvider {
	authorizationUrl: URL | undefined;
	private discovered: OAuthAuthorizationServerInformation | undefined;

	constructor(
		readonly credentials: Credentials,
		private options: Options,
	) {}

	get redirectUrl() {
		return this.options.redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Ponder Chat",
			client_uri: originOf(hosts()[0]!),
			redirect_uris: callbackUrls(),
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
		const expiresAt = typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : undefined;
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
		if (!this.options.verifier) throw new ConnectorProblem("This sign-in has no code verifier. Start it again.");
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
		if (!(await runPromise(NetGuard.NetGuard)).privateNetworksAllowed) {
			if (url.protocol !== "https:") throw new ConnectorProblem("The server's sign-in is not on https.");
			NetGuard.assertPublicHost(url);
		}
		const client = this.credentials.client;
		if (client?.client_secret && !client.issuer && !this.authorizationServerInformation()) this.discovered = await discoverAuthorizationServer(url);
	}
}

/** RFC 8414 metadata, then OpenID Connect discovery, as the SDK looks for them. */
async function discoverAuthorizationServer(server: URL): Promise<OAuthAuthorizationServerInformation | undefined> {
	const path = server.pathname === "/" ? "" : server.pathname.replace(/\/$/, "");
	const candidates = [
		`/.well-known/oauth-authorization-server${path}`,
		`/.well-known/openid-configuration${path}`,
		...(path ? [`${path}/.well-known/openid-configuration`] : []),
	];
	let failure: unknown;
	let answered = false;
	const fetch = await guardedFetch();
	for (const candidate of candidates) {
		const response = await fetch(new URL(candidate, server.origin), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }).catch((error) => {
			failure = error;
			return undefined;
		});
		if (!response) continue;
		answered = true;
		if (!response.ok) {
			await response.body?.cancel();
			continue;
		}
		const metadata = (await response.json().catch(() => undefined)) as { issuer?: string; token_endpoint?: string } | undefined;
		if (!metadata?.issuer || !metadata.token_endpoint) continue;
		return { issuer: metadata.issuer, authorizationServerUrl: server.toString(), tokenEndpoint: metadata.token_endpoint };
	}
	// Nothing answered (a timeout, the network): not the same as a server with no metadata.
	if (!answered) {
		console.warn(`connectors: no metadata address of the authorization server ${server.host} answered:`, describeError(failure));
		throw new ConnectorProblem("Could not reach the server's sign-in. Try again.");
	}
	return undefined;
}

/**
 * Starts a sign-in: finds the authorization server, registers Ponder if needed, and
 * returns the URL where the person signs in. The verifier and the hash of the state wait
 * in mcp_sign_ins for 10 minutes. `origin` is the host the person uses, so the callback
 * gets their session cookie.
 */
export async function startSignIn(input: {
	userId: string;
	origin: string;
	url: string;
	connectionId: string | null;
	credentials: Credentials;
	draft?: SignInSecret["draft"];
}): Promise<string> {
	const state = randomBytes(32).toString("base64url");
	const redirectUrl = `${input.origin}${CALLBACK_PATH}`;
	// A new sign-in starts without tokens, so the SDK asks for a new authorization instead of refreshing.
	const provider = new ConnectorOAuth({ ...input.credentials, tokens: undefined }, { redirectUrl, state });
	const result = await auth(provider, { serverUrl: input.url, fetchFn: await guardedFetch() });
	if (result !== "REDIRECT" || !provider.authorizationUrl) throw new ConnectorProblem("The server did not ask for a sign-in.");
	await saveSignIn(state, input.userId, input.connectionId, {
		verifier: provider.verifier,
		redirectUrl,
		credentials: provider.credentials,
		draft: input.draft,
	});
	return provider.authorizationUrl.toString();
}

/** Ends a sign-in with the code from the callback. Returns the credentials with their tokens. */
export async function finishSignIn(input: { userId: string; state: string; code: string; issuer?: string; url: (signIn: { connectionId: string | null; secret: SignInSecret }) => Promise<string | undefined> }) {
	const signIn = await takeSignIn(input.state, input.userId);
	if (!signIn) throw new ConnectorProblem("This sign-in expired or was used already. Start it again from Settings, Connectors.");
	const url = await input.url(signIn);
	if (!url) throw new ConnectorProblem("The connector was removed during the sign-in.");
	const provider = new ConnectorOAuth(signIn.secret.credentials, { redirectUrl: signIn.secret.redirectUrl, state: input.state, verifier: signIn.secret.verifier });
	await auth(provider, { serverUrl: url, authorizationCode: input.code, callbackState: input.state, callbackIssuer: input.issuer, fetchFn: await guardedFetch() });
	if (!provider.credentials.tokens?.access_token) throw new ConnectorProblem("The server did not give Ponder a token.");
	return { connectionId: signIn.connectionId, draft: signIn.secret.draft, credentials: provider.credentials };
}

/** The provider for calls outside a sign-in: it saves refreshed or refused tokens to the connection. */
export function backgroundOAuth(connection: Pick<Connection, "id">, credentials: Credentials) {
	return new ConnectorOAuth(credentials, {
		redirectUrl: callbackUrls()[0]!,
		persist: async (changed) => {
			const signedOut = !changed.tokens?.access_token;
			await saveCredentials(connection.id, changed, signedOut ? { status: "needs_sign_in", lastError: "The sign-in ended. Sign in again." } : undefined);
		},
	});
}

const REFRESH_EARLY_MS = 60_000;
const refreshing = new Map<string, Promise<Credentials>>();

/**
 * Credentials with a token that is good for at least another minute. Refreshes one
 * connection one time at a time: two tool calls at once must not both use a refresh token
 * that the server rotates. (One process runs Ponder, so a lock in memory is enough.)
 */
export async function freshCredentials(connection: Connection, credentials: Credentials): Promise<Credentials> {
	if (connection.auth !== "oauth") return credentials;
	if (!credentials.tokens?.access_token) throw new NeedsSignIn();
	const expiresAt = tokenExpiry(credentials);
	if (!expiresAt || expiresAt.getTime() - Date.now() > REFRESH_EARLY_MS) return credentials;
	if (!credentials.tokens.refresh_token) throw new NeedsSignIn();
	let pending = refreshing.get(connection.id);
	if (!pending) {
		pending = (async () => {
			const provider = backgroundOAuth(connection, credentials);
			const result = await auth(provider, { serverUrl: connection.url, fetchFn: await guardedFetch() });
			if (result !== "AUTHORIZED" || !provider.credentials.tokens?.access_token) throw new NeedsSignIn();
			return provider.credentials;
		})().finally(() => refreshing.delete(connection.id));
		refreshing.set(connection.id, pending);
	}
	return pending;
}
