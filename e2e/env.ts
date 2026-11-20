/** Where the end-to-end tests run: shared by start.ts, playwright.config.ts and the fixtures. */
const port = Number(process.env.E2E_PORT ?? 3597);
const fakePort = Number(process.env.E2E_FAKE_PORT ?? 3598);
/** The test MCP servers (mcp/server.ts): the open and key servers, and the one with OAuth. */
const mcpPort = Number(process.env.E2E_MCP_PORT ?? 3599);
const mcpOAuthPort = Number(process.env.E2E_MCP_OAUTH_PORT ?? 3600);
/** The stand-in for Microsoft's sign-in (microsoft/server.ts). */
const microsoftPort = Number(process.env.E2E_MICROSOFT_PORT ?? 3601);
/** The Ponders that the durability tests stop and start again: slot 0's port, and the ports below it. */
const durabilityPort = Number(process.env.E2E_DURABILITY_PORT ?? 3596);
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://ponder:ponder@127.0.0.1:55433/ponder_e2e";

export const e2e = {
	port,
	fakePort,
	mcpPort,
	mcpOAuthPort,
	microsoftPort,
	durabilityPort,
	baseUrl: `http://127.0.0.1:${port}`,
	fakeUrl: `http://127.0.0.1:${fakePort}`,
	mcpUrl: `http://127.0.0.1:${mcpPort}`,
	mcpOAuthUrl: `http://127.0.0.1:${mcpOAuthPort}`,
	microsoftUrl: `http://127.0.0.1:${microsoftPort}`,
	databaseUrl,
	/**
	 * The Ponder of one durability file (durability.ts): its port, and its own database on
	 * the same Postgres. One server holds the workflow worker of a database, so each file
	 * that stops its server needs its own.
	 */
	durability(slot: number, name: string) {
		const database = new URL(databaseUrl);
		database.pathname = `/ponder_durability_${name}_e2e`;
		return { port: durabilityPort - slot, databaseUrl: database.href };
	},
};
