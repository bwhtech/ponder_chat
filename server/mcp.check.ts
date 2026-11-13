/**
 * Checks connectors (server/mcp/) against a small MCP server and OAuth server that this
 * script starts on 127.0.0.1: the URL guard, tool names, probing, a server with no
 * sign-in, one with an API key, OAuth with dynamic registration and with a person's own
 * app, refresh one at a time, refused tokens, and that one person can't use another's
 * connection. It writes to the database in DATABASE_URL, with two test people that it
 * deletes at the end.
 *
 * Run: set -a; . ~/.config/ponder-chat/.env; set +a; npx tsx server/mcp.check.ts [--live]
 * --live also connects to https://mcp.deepwiki.com/mcp (no sign-in).
 * --serve only runs the test servers, to try connectors in the browser. Their sign-in
 * says yes at once. Start Ponder with MCP_ALLOW_PRIVATE_NETWORKS=1 to reach them.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import type { SignedInEnv } from "./auth.ts";
import { sql } from "./db.ts";
import { forgetClient } from "./mcp/client.ts";
import { addConnector, callConnectorTool, changeConnector, completeSignIn, connectorCatalogFor, listConnectors, removeConnector } from "./mcp/connectors.ts";
import { freshCredentials } from "./mcp/oauth.ts";
import { probe } from "./mcp/probe.ts";
import { connectorsApi } from "./mcp/routes.ts";
import { getConnection, migrateConnectors, readCredentials } from "./mcp/store.ts";
import { MAX_RESULT_CHARS, modelToolName, resultText, slugFor } from "./mcp/tools.ts";
import { guardedFetch, mcpUrlProblem } from "./net-guard.ts";
import { seal, unseal } from "./secrets.ts";

const live = process.argv.includes("--live");
const ORIGIN = "http://localhost:3500";
let failed = 0;

async function check(name: string, body: () => Promise<void>) {
	try {
		await body();
		console.log(`ok   ${name}`);
	} catch (error) {
		failed++;
		console.log(`FAIL ${name}\n     ${error instanceof Error ? (error.stack ?? error.message) : error}`);
	}
}

// The test servers: an MCP server at /open/mcp (no sign-in), /key/mcp (x-api-key) and
// /oauth/mcp (OAuth), and an authorization server at /as.

const mock = {
	accessTtl: 3600,
	refreshes: 0,
	clients: new Map<string, { secret?: string }>(),
	codes: new Map<string, { challenge: string; clientId: string; redirectUri: string }>(),
	access: new Set<string>(),
	refresh: new Map<string, string>(),
	revokeAll() {
		this.access.clear();
		this.refresh.clear();
	},
};
let base = "";

const TOOLS = [
	{ name: "echo", title: "Echo", description: "Repeats the text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
	{ name: "create_item", description: "Creates an item.", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
	{ name: "big", description: "Returns a lot of text.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];

function rpc(message: { id?: number | string; method: string; params?: Record<string, unknown> }) {
	const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
	switch (message.method) {
		case "initialize":
			return reply({
				protocolVersion: (message.params?.protocolVersion as string) ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "check-server", title: "Check Server", version: "1.0.0" },
				instructions: "Use echo to repeat text.",
			});
		case "ping":
			return reply({});
		case "tools/list":
			return reply({ tools: TOOLS });
		case "tools/call": {
			const args = (message.params?.arguments ?? {}) as Record<string, string>;
			const text = message.params?.name === "echo" ? args.text : message.params?.name === "big" ? "x".repeat(200_000) : `created ${args.title}`;
			return reply({ content: [{ type: "text", text }] });
		}
		default:
			return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
	}
}

async function readBody(request: IncomingMessage) {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString();
}

function send(response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
	response.writeHead(status, { ...(body !== undefined && { "content-type": "application/json" }), ...headers });
	response.end(body === undefined ? undefined : JSON.stringify(body));
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

function issueTokens(clientId: string) {
	const access = `at-${randomBytes(8).toString("hex")}`;
	const refresh = `rt-${randomBytes(8).toString("hex")}`;
	mock.access.add(access);
	mock.refresh.set(refresh, clientId);
	return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: mock.accessTtl };
}

async function handle(request: IncomingMessage, response: ServerResponse) {
	const url = new URL(request.url!, base);
	const path = url.pathname;
	const body = request.method === "POST" ? await readBody(request) : "";

	if (path === "/.well-known/oauth-protected-resource/oauth/mcp") return send(response, 200, { resource: `${base}/oauth/mcp`, authorization_servers: [`${base}/as`] });
	if (path === "/.well-known/oauth-authorization-server/as")
		return send(response, 200, {
			issuer: `${base}/as`,
			authorization_endpoint: `${base}/as/authorize`,
			token_endpoint: `${base}/as/token`,
			registration_endpoint: `${base}/as/register`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
		});
	if (path === "/as/register") {
		const clientId = `dyn-${randomBytes(4).toString("hex")}`;
		mock.clients.set(clientId, {});
		return send(response, 201, { ...JSON.parse(body), client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
	}
	if (path === "/as/authorize") {
		const q = url.searchParams;
		if (!mock.clients.has(q.get("client_id")!) || q.get("code_challenge_method") !== "S256") return send(response, 400, { error: "invalid_request" });
		const code = `code-${randomBytes(8).toString("hex")}`;
		mock.codes.set(code, { challenge: q.get("code_challenge")!, clientId: q.get("client_id")!, redirectUri: q.get("redirect_uri")! });
		const back = new URL(q.get("redirect_uri")!);
		back.search = new URLSearchParams({ code, state: q.get("state")!, iss: `${base}/as` }).toString();
		return send(response, 302, undefined, { location: back.toString() });
	}
	if (path === "/as/token") {
		const form = new URLSearchParams(body);
		const basic = request.headers.authorization?.startsWith("Basic ") ? Buffer.from(request.headers.authorization.slice(6), "base64").toString().split(":") : [];
		const clientId = decodeURIComponent(basic[0] ?? form.get("client_id") ?? "");
		const secret = basic[1] !== undefined ? decodeURIComponent(basic[1]) : form.get("client_secret");
		const client = mock.clients.get(clientId);
		if (!client || (client.secret && client.secret !== secret)) return send(response, 401, { error: "invalid_client" });
		if (form.get("grant_type") === "authorization_code") {
			const code = mock.codes.get(form.get("code")!);
			mock.codes.delete(form.get("code")!);
			if (!code || code.clientId !== clientId || s256(form.get("code_verifier") ?? "") !== code.challenge || code.redirectUri !== form.get("redirect_uri"))
				return send(response, 400, { error: "invalid_grant" });
			return send(response, 200, issueTokens(clientId));
		}
		if (form.get("grant_type") === "refresh_token") {
			const owner = mock.refresh.get(form.get("refresh_token")!);
			if (owner !== clientId) return send(response, 400, { error: "invalid_grant" });
			mock.refresh.delete(form.get("refresh_token")!);
			mock.refreshes++;
			return send(response, 200, issueTokens(clientId));
		}
		return send(response, 400, { error: "unsupported_grant_type" });
	}

	if (path === "/open/mcp" || path === "/key/mcp" || path === "/oauth/mcp") {
		if (path === "/key/mcp" && request.headers["x-api-key"] !== "right-key") return send(response, 401, { error: "missing key" });
		if (path === "/oauth/mcp" && !mock.access.has(request.headers.authorization?.replace(/^Bearer /, "") ?? ""))
			return send(response, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/oauth/mcp"` });
		if (request.method === "DELETE") return send(response, 200);
		if (request.method !== "POST") return send(response, 405);
		const message = JSON.parse(body);
		if (message.id === undefined) return send(response, 202);
		return send(response, 200, rpc(message));
	}
	return send(response, 404, { error: "not found" });
}

const server = createServer((request, response) => void handle(request, response).catch((error) => send(response, 500, { error: String(error) })));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

if (process.argv.includes("--serve")) {
	console.log(`Test MCP servers:\n  ${base}/open/mcp   no sign-in\n  ${base}/key/mcp    header x-api-key: right-key\n  ${base}/oauth/mcp  OAuth`);
	await new Promise(() => undefined);
}

// Two test people.
const people = [`check-${randomUUID()}`, `check-${randomUUID()}`] as const;
const [alice, bob] = people;
await migrateConnectors();
for (const id of people) await sql`insert into users (id, name, email, "emailVerified") values (${id}, 'Connector check', ${`${id}@example.invalid`}, true)`;

try {
	await check("a sealed value copied to another row does not decrypt", async () => {
		const sealed = seal("mcp_connections:a:credentials", "secret");
		assert.equal(unseal("mcp_connections:a:credentials", sealed), "secret");
		assert.throws(() => unseal("mcp_connections:b:credentials", sealed));
	});

	await check("private addresses and plain http are refused", async () => {
		delete process.env.MCP_ALLOW_PRIVATE_NETWORKS;
		for (const address of ["https://127.0.0.1/mcp", "https://10.0.0.5/mcp", "https://100.100.1.1/mcp", "https://[::1]/mcp", "https://localhost/mcp", "http://example.com/mcp"])
			assert.ok(mcpUrlProblem(address), address);
		assert.equal(mcpUrlProblem("https://mcp.example.com/mcp"), null);
		await assert.rejects(guardedFetch(`${base}/open/mcp`), "plain http to 127.0.0.1 was allowed");
		await assert.rejects(guardedFetch("https://127.0.0.1/"), "127.0.0.1 was allowed");
		const probed = await probe(`${base}/open/mcp`);
		assert.equal(probed.ok, false);
	});

	// The rest talks to the test servers on 127.0.0.1.
	process.env.MCP_ALLOW_PRIVATE_NETWORKS = "1";

	await check("tool names are unique, short and safe", async () => {
		assert.equal(modelToolName("linear", "create_issue"), "linear__create_issue");
		assert.equal(modelToolName("notion", "notion-search.v2"), "notion__notion-search_v2");
		const long = modelToolName("server", "a".repeat(100));
		assert.ok(long.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(long));
		assert.notEqual(long, modelToolName("server", `${"a".repeat(99)}b`));
		assert.equal(slugFor("Linear", new Set()), "linear");
		assert.equal(slugFor("Linear", new Set(["linear"])), "linear_2");
		assert.equal(slugFor("BWH HQ (Frappe)!", new Set()), "bwh_hq_frappe");
		assert.equal(slugFor("🙂", new Set()), "mcp");
	});

	await check("a long result is cut", async () => {
		const { text } = resultText({ content: [{ type: "text", text: "x".repeat(MAX_RESULT_CHARS * 2) }] });
		assert.ok(text.length < MAX_RESULT_CHARS + 200 && text.includes("[Cut:"));
	});

	await check("probe tells no sign-in, a key and OAuth apart", async () => {
		assert.deepEqual(await probe(`${base}/open/mcp`), { ok: true, transport: "http", auth: "none", name: "Check Server", message: "No sign-in needed. Anyone with the address can use this server." });
		const key = await probe(`${base}/key/mcp`);
		assert.ok(key.ok && key.auth === "headers", JSON.stringify(key));
		const oauth = await probe(`${base}/oauth/mcp`);
		assert.ok(oauth.ok && oauth.auth === "oauth", JSON.stringify(oauth));
		const missing = await probe(`${base}/nothing`);
		assert.equal(missing.ok, false);
	});

	await check("probe says it could not check the sign-in when no metadata address answers", async () => {
		// A server that asks for a sign-in, then drops the connection on every other request:
		// that is a server it could not check, not a server that wants a key.
		const flaky = createServer((request, response) => {
			if (request.method === "POST" && request.url === "/mcp") return send(response, 401, { error: "unauthorized" });
			request.socket.destroy();
		});
		await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", resolve));
		try {
			const probed = await probe(`http://127.0.0.1:${(flaky.address() as AddressInfo).port}/mcp`);
			assert.deepEqual(probed, { ok: false, message: "Could not reach the server to check how it signs in. Try again." });
		} finally {
			flaky.close();
		}
	});

	await check("a connectors request whose body is not JSON is a 400 that says so", async () => {
		const app = new Hono<SignedInEnv>()
			.use(async (c, next) => {
				c.set("user", { id: alice } as SignedInEnv["Variables"]["user"]);
				await next();
			})
			.route("/", connectorsApi);
		const response = await app.request("/probe", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: "The request body is not valid JSON." });
	});

	let openId = "";
	await check("a server with no sign-in: add, list tools, call", async () => {
		const added = await addConnector(alice, ORIGIN, { name: "Check Open", url: `${base}/open/mcp`, transport: "http", auth: "none", headers: [] });
		assert.ok("connector" in added);
		openId = added.connector.id;
		assert.deepEqual(added.connector.tools.map((tool) => [tool.modelName, tool.rule]), [
			["check_open__echo", "allow"],
			["check_open__create_item", "ask"],
			["check_open__big", "allow"],
		]);
		assert.equal(await callConnectorTool(openId, "echo", { text: "hello" }, alice, false), "hello");
		const big = await callConnectorTool(openId, "big", {}, alice, false);
		assert.ok(big.length < MAX_RESULT_CHARS + 200);
		await assert.rejects(addConnector(alice, ORIGIN, { name: "Again", url: `${base}/open/mcp`, transport: "http", auth: "none", headers: [] }), /already have/);
	});

	await check("the catalog: rules decide which tools are in it and which ask first", async () => {
		await changeConnector(alice, openId, { rules: { big: "off" } });
		const catalog = await connectorCatalogFor(alice);
		assert.deepEqual(catalog.tools.map((tool) => [tool.name, tool.ask]), [
			["check_open__create_item", true],
			["check_open__echo", false],
		]);
		assert.deepEqual(catalog.connectors, [{ slug: "check_open", name: "Check Open", server: "Check Server", notes: "Use echo to repeat text.", tools: 2 }]);
		// A tool that is off is named, so a call to it says so, but it has no schema and never runs.
		assert.deepEqual(catalog.off, [{ name: "check_open__big", title: "big" }]);
		assert.match(await callConnectorTool(openId, "big", {}, alice, false), /turned .* off/);
		// A tool on "Ask first" runs only when the call says the person approved it.
		assert.match(await callConnectorTool(openId, "create_item", { title: "x" }, alice, false), /did not approve this call, so it did not run/);
		assert.equal(await callConnectorTool(openId, "create_item", { title: "x" }, alice, true), "created x");
		assert.match(await callConnectorTool(openId, "no_such_tool", {}, alice, true), /has no tool named no_such_tool/);
		await changeConnector(alice, openId, { rules: { big: null }, enabled: false });
		assert.deepEqual(await connectorCatalogFor(alice), { tools: [], connectors: [], leftOut: 0, off: [] });
		await changeConnector(alice, openId, { enabled: true });
	});

	await check("a server with an API key: a wrong key fails, the right one works", async () => {
		await assert.rejects(addConnector(alice, ORIGIN, { name: "Check Key", url: `${base}/key/mcp`, transport: "http", auth: "headers", headers: [{ name: "x-api-key", value: "wrong" }] }));
		await assert.rejects(addConnector(alice, ORIGIN, { name: "Check Key", url: `${base}/key/mcp`, transport: "http", auth: "headers", headers: [{ name: "Host", value: "x" }] }), /sets the Host header/);
		const added = await addConnector(alice, ORIGIN, { name: "Check Key", url: `${base}/key/mcp`, transport: "http", auth: "headers", headers: [{ name: "x-api-key", value: "right-key" }] });
		assert.ok("connector" in added);
		assert.deepEqual(added.connector.headerNames, ["x-api-key"]);
		assert.ok(!JSON.stringify(await listConnectors(alice)).includes("right-key"), "the key reached the page");
		assert.equal(await callConnectorTool(added.connector.id, "echo", { text: "keyed" }, alice, false), "keyed");
	});

	async function signIn(user: string, input: { name: string; clientId?: string; clientSecret?: string }, query = "") {
		const started = await addConnector(user, ORIGIN, { ...input, url: `${base}/oauth/mcp${query}`, transport: "http", auth: "oauth", headers: [] });
		assert.ok("authorizeUrl" in started);
		const response = await fetch(started.authorizeUrl, { redirect: "manual" });
		const back = new URL(response.headers.get("location")!);
		assert.equal(`${back.origin}${back.pathname}`, `${ORIGIN}/oauth/mcp/callback`);
		const params = { state: back.searchParams.get("state")!, code: back.searchParams.get("code")!, issuer: back.searchParams.get("iss")! };
		return { params, ...(await completeSignIn(user, params)) };
	}

	let oauthId = "";
	await check("OAuth with dynamic registration: sign in, call, and the state works once", async () => {
		const { id, params } = await signIn(alice, { name: "Check OAuth" });
		oauthId = id;
		const connection = (await getConnection(id, alice))!;
		assert.equal(connection.status, "connected");
		assert.equal(connection.tools.length, 3);
		assert.ok(readCredentials(connection).client?.client_id.startsWith("dyn-"));
		assert.equal(await callConnectorTool(id, "echo", { text: "signed in" }, alice, false), "signed in");
		await assert.rejects(completeSignIn(alice, params), /expired or was used/);
	});

	await check("someone else's sign-in state does not work", async () => {
		const started = await addConnector(alice, ORIGIN, { name: "Check OAuth 2", url: `${base}/oauth/mcp?second`, transport: "http", auth: "oauth", headers: [] });
		assert.ok("authorizeUrl" in started);
		const back = new URL((await fetch(started.authorizeUrl, { redirect: "manual" })).headers.get("location")!);
		await assert.rejects(completeSignIn(bob, { state: back.searchParams.get("state")!, code: back.searchParams.get("code")! }), /expired or was used/);
	});

	await check("a token about to expire is refreshed once, even by two calls at the same time", async () => {
		mock.accessTtl = 30;
		const { id } = await signIn(bob, { name: "Check Refresh" });
		const connection = (await getConnection(id, bob))!;
		const before = mock.refreshes;
		const [one, two] = await Promise.all([freshCredentials(connection, readCredentials(connection)), freshCredentials(connection, readCredentials(connection))]);
		assert.equal(mock.refreshes, before + 1);
		assert.equal(one.tokens?.access_token, two.tokens?.access_token);
		assert.equal(readCredentials((await getConnection(id, bob))!).tokens?.access_token, one.tokens?.access_token, "the new token was not saved");
		mock.accessTtl = 3600;
		forgetClient(id);
		assert.equal(await callConnectorTool(id, "echo", { text: "refreshed" }, bob, false), "refreshed");
	});

	await check("refused tokens: the connection needs a new sign-in, and the model is told", async () => {
		mock.revokeAll();
		forgetClient(oauthId);
		const text = await callConnectorTool(oauthId, "echo", { text: "x" }, alice, false);
		assert.match(text, /sign in again/);
		assert.equal((await getConnection(oauthId, alice))!.status, "needs_sign_in");
		const catalog = await connectorCatalogFor(alice);
		assert.equal(catalog.tools.filter((tool) => tool.connectionId === oauthId).length, 0);
		assert.ok(catalog.connectors.some((connector) => connector.slug === "check_oauth" && connector.unavailable === "sign-in" && connector.tools === 0));
	});

	await check("OAuth with the person's own app and secret", async () => {
		mock.clients.set("own-app", { secret: "own-secret" });
		const { id } = await signIn(bob, { name: "Check Own App", clientId: "own-app", clientSecret: "own-secret" }, "?own");
		const connection = (await getConnection(id, bob))!;
		assert.equal(connection.oauthClientId, "own-app");
		assert.equal(await callConnectorTool(id, "echo", { text: "own app" }, bob, false), "own app");
	});

	await check("one person can't read, call, change or remove another's connection", async () => {
		assert.equal(await getConnection(openId, bob), undefined);
		assert.equal(await callConnectorTool(openId, "echo", { text: "x" }, bob, false), "This connector was removed.");
		await assert.rejects(changeConnector(bob, openId, { enabled: false }), /not found/);
		assert.equal(await removeConnector(bob, openId), false);
		assert.ok((await listConnectors(bob)).every((connector) => !connector.url.includes("/open/")));
		assert.equal(await removeConnector(alice, openId), true);
	});

	if (live) {
		delete process.env.MCP_ALLOW_PRIVATE_NETWORKS;
		await check("live: DeepWiki, with no sign-in", async () => {
			const probed = await probe("https://mcp.deepwiki.com/mcp");
			assert.ok(probed.ok && probed.auth === "none", JSON.stringify(probed));
			const added = await addConnector(alice, ORIGIN, { name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp", transport: probed.transport, auth: "none", headers: [] });
			assert.ok("connector" in added && added.connector.tools.length > 0);
			const text = await callConnectorTool(added.connector.id, "read_wiki_structure", { repoName: "frappe/frappe" }, alice, true);
			assert.ok(text.length > 100, text);
		});
	}
} finally {
	for (const id of people) await sql`delete from users where id = ${id}`;
	server.close();
	await sql.end();
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
