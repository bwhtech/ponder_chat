/**
 * Starts what the end-to-end tests run against: a new, empty database, the fake
 * OpenRouter (fake/server.ts), the test MCP servers (mcp/server.ts), the stand-in for
 * Microsoft's sign-in (microsoft/server.ts) and Ponder's build (.output/, from `npm run build`).
 * Playwright runs it as its web server (playwright.config.ts), and stops it after the
 * tests. Run it by hand to look at the app as the tests see it: npx tsx e2e/start.ts
 *
 * E2E_DATABASE_URL is a Postgres server with pgvector, and the database to create on
 * it. It is dropped and made again on each start, so its name must end in "_e2e".
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { startFake } from "./fake/server.ts";
import { e2e } from "./env.ts";
import { startMcp } from "./mcp/server.ts";
import { startMicrosoft } from "./microsoft/server.ts";
import { newDatabase, ponderEnv } from "./ponder.ts";

const database = new URL(e2e.databaseUrl).pathname.slice(1);
if (!existsSync(".output/server/index.mjs")) {
	console.error("There is no build. Run npm run build first.");
	process.exit(1);
}

// A new database, so every run starts from nothing.
await newDatabase(e2e.databaseUrl).catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
const env = ponderEnv(e2e.port, e2e.databaseUrl);

const fake = startFake(e2e.fakePort);
const mcp = startMcp(e2e.mcpPort, e2e.mcpOAuthPort);
const microsoft = startMicrosoft(e2e.microsoftPort);
const ponder = spawn("node", [".output/server/index.mjs"], { env, stdio: "inherit" });
console.log(`e2e: Ponder on ${e2e.baseUrl}, the fake OpenRouter on ${e2e.fakeUrl}, MCP servers on ${e2e.mcpUrl} and ${e2e.mcpOAuthUrl}, the fake Microsoft on ${e2e.microsoftUrl}, database ${database}`);

function stop() {
	ponder.kill("SIGTERM");
	fake.close();
	mcp.close();
	microsoft.close();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
ponder.on("exit", (code) => {
	fake.close();
	mcp.close();
	microsoft.close();
	process.exit(code ?? 0);
});
