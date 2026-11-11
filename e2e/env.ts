/** Where the end-to-end tests run: shared by start.ts, playwright.config.ts and the fixtures. */
const port = Number(process.env.E2E_PORT ?? 3597);
const fakePort = Number(process.env.E2E_FAKE_PORT ?? 3598);
/** The test MCP servers (mcp/server.ts): the open and key servers, and the one with OAuth. */
const mcpPort = Number(process.env.E2E_MCP_PORT ?? 3599);
const mcpOAuthPort = Number(process.env.E2E_MCP_OAUTH_PORT ?? 3600);

export const e2e = {
	port,
	fakePort,
	mcpPort,
	mcpOAuthPort,
	baseUrl: `http://127.0.0.1:${port}`,
	fakeUrl: `http://127.0.0.1:${fakePort}`,
	mcpUrl: `http://127.0.0.1:${mcpPort}`,
	mcpOAuthUrl: `http://127.0.0.1:${mcpOAuthPort}`,
	databaseUrl: process.env.E2E_DATABASE_URL ?? "postgres://ponder:ponder@127.0.0.1:55433/ponder_e2e",
};
