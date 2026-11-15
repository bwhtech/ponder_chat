import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import type { McpCall } from "./calls.ts";

/**
 * MCP servers for the connector tests, made with the official MCP SDK
 * (@modelcontextprotocol/sdk), so Ponder's client talks to a real server.
 *
 * - On one port: /open/mcp needs no sign-in, and /key/mcp needs `Authorization: Bearer shop-key`.
 *   GET /__mcp/calls?match=&since= lists the tool calls that the servers ran.
 * - On another port: /mcp needs an OAuth sign-in. The same app is its authorization
 *   server, with dynamic client registration, and its sign-in page says yes at once.
 *   It is on its own port because Ponder looks for OAuth metadata at the root of the
 *   server's address, and the key server must not have any.
 *
 * Each server has two tools: find_order only reads, and add_note changes something.
 * find_order and add_note take SLOW_MS for an order that starts with "SLOW", so a test can stop
 * Ponder in the middle of the call (tests/durability-crash.spec.ts). The call is recorded first.
 */
const SLOW_MS = 6_000;
export const SHOP_KEY = "shop-key";
const calls: McpCall[] = [];

function shop(server: McpCall["server"]) {
	const mcp = new McpServer({ name: "test-shop", title: "Test Shop", version: "1.0.0" }, { instructions: "Use find_order to look up an order." });
	mcp.registerTool(
		"find_order",
		{ title: "Find order", description: "Finds an order by its number.", inputSchema: { order: z.string() }, annotations: { readOnlyHint: true } },
		async (args) => {
			calls.push({ server, tool: "find_order", args, at: Date.now() });
			if (args.order.startsWith("SLOW")) await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
			return { content: [{ type: "text", text: `Order ${args.order}: 2 blue mugs, shipped on 3 November.` }] };
		},
	);
	mcp.registerTool(
		"add_note",
		{ title: "Add note", description: "Adds a note to an order.", inputSchema: { order: z.string(), note: z.string() } },
		async (args) => {
			calls.push({ server, tool: "add_note", args, at: Date.now() });
			if (args.order.startsWith("SLOW")) await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
			return { content: [{ type: "text", text: `Added the note to order ${args.order}.` }] };
		},
	);
	return mcp;
}

/** Answers one request with a new server, without sessions (stateless Streamable HTTP). */
function serve(server: McpCall["server"]) {
	return async (req: Request, res: Response) => {
		const mcp = shop(server);
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		res.on("close", () => {
			void transport.close();
			void mcp.close();
		});
		await mcp.connect(transport);
		await transport.handleRequest(req, res, req.body);
	};
}

/** Without sessions there is no stream to open or session to end. */
const notAllowed = (_req: Request, res: Response) => void res.status(405).set("Allow", "POST").end();

function shopApp() {
	const app = express();
	// A long argument, such as the note in compaction.spec.ts, is over the default 100 KB.
	app.use(express.json({ limit: "1mb" }));
	app.post("/open/mcp", serve("open"));
	app.post(
		"/key/mcp",
		(req, res, next) => (req.headers.authorization === `Bearer ${SHOP_KEY}` ? next() : void res.status(401).json({ error: "A valid API key is needed." })),
		serve("key"),
	);
	app.all(["/open/mcp", "/key/mcp"], notAllowed);
	app.get("/__mcp/calls", (req, res) => {
		const match = String(req.query.match ?? "");
		const since = Number(req.query.since ?? 0);
		res.json(calls.filter((call) => call.at >= since && JSON.stringify(call.args).includes(match)));
	});
	return app;
}

/** An authorization server whose sign-in says yes at once, and remembers nothing on disk. */
class SaysYes implements OAuthServerProvider {
	private clients = new Map<string, OAuthClientInformationFull>();
	private codes = new Map<string, { clientId: string; challenge: string }>();
	private tokens = new Map<string, { clientId: string; expiresAt: number }>();
	private refreshTokens = new Map<string, string>();

	get clientsStore() {
		return {
			getClient: (id: string) => this.clients.get(id),
			registerClient: (client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) => {
				const full = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
				this.clients.set(full.client_id, full);
				return full;
			},
		};
	}

	async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
		const code = randomBytes(16).toString("hex");
		this.codes.set(code, { clientId: client.client_id, challenge: params.codeChallenge });
		const back = new URL(params.redirectUri);
		back.searchParams.set("code", code);
		if (params.state) back.searchParams.set("state", params.state);
		res.redirect(302, back.href);
	}

	async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string) {
		const found = this.codes.get(code);
		if (!found) throw new Error("Unknown code");
		return found.challenge;
	}

	async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string) {
		const found = this.codes.get(code);
		if (!found || found.clientId !== client.client_id) throw new Error("Unknown code");
		this.codes.delete(code);
		return this.issue(client.client_id);
	}

	async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string) {
		if (this.refreshTokens.get(refreshToken) !== client.client_id) throw new Error("Unknown refresh token");
		this.refreshTokens.delete(refreshToken);
		return this.issue(client.client_id);
	}

	async verifyAccessToken(token: string) {
		const found = this.tokens.get(token);
		if (!found) throw new Error("Unknown token");
		return { token, clientId: found.clientId, scopes: [], expiresAt: found.expiresAt };
	}

	private issue(clientId: string) {
		const access = randomBytes(16).toString("hex");
		const refresh = randomBytes(16).toString("hex");
		this.tokens.set(access, { clientId, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
		this.refreshTokens.set(refresh, clientId);
		return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 };
	}
}

function oauthApp(origin: string) {
	const provider = new SaysYes();
	const resource = new URL("/mcp", origin);
	const app = express();
	app.use(
		mcpAuthRouter({
			provider,
			issuerUrl: new URL(origin),
			resourceServerUrl: resource,
			// Every test's sign-in comes from 127.0.0.1.
			authorizationOptions: { rateLimit: false },
			tokenOptions: { rateLimit: false },
			clientRegistrationOptions: { rateLimit: false },
		}),
	);
	app.post("/mcp", requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) }), express.json(), serve("oauth"));
	app.all("/mcp", notAllowed);
	return app;
}

/** Starts both apps on 127.0.0.1. */
export function startMcp(port: number, oauthPort: number) {
	const servers: Server[] = [shopApp().listen(port, "127.0.0.1"), oauthApp(`http://127.0.0.1:${oauthPort}`).listen(oauthPort, "127.0.0.1")];
	return { close: () => servers.forEach((server) => server.close()) };
}
