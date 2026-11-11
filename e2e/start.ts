/**
 * Starts what the end-to-end tests run against: a new, empty database, the fake
 * OpenRouter (fake/server.ts) and Ponder's build (.output/, from `npm run build`).
 * Playwright runs it as its web server (playwright.config.ts), and stops it after the
 * tests. Run it by hand to look at the app as the tests see it: npx tsx e2e/start.ts
 *
 * E2E_DATABASE_URL is a Postgres server with pgvector, and the database to create on
 * it. It is dropped and made again on each start, so its name must end in "_e2e".
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import postgres from "postgres";
import { FAKE_KEY, startFake } from "./fake/server.ts";
import { e2e } from "./env.ts";

const database = new URL(e2e.databaseUrl).pathname.slice(1);
if (!database.endsWith("_e2e")) {
	console.error(`Refusing to reset "${database}": the test database's name must end in "_e2e". Each run drops it.`);
	process.exit(1);
}
if (!existsSync(".output/server/index.mjs")) {
	console.error("There is no build. Run npm run build first.");
	process.exit(1);
}

// A new database, so every run starts from nothing.
const server = new URL(e2e.databaseUrl);
server.pathname = "/postgres";
const admin = postgres(server.href, { onnotice: () => {} });
await admin.unsafe(`drop database if exists "${database}" with (force)`);
await admin.unsafe(`create database "${database}"`);
await admin.end();

// Only what Node and npm need from this shell. A shell with Ponder's own settings, such
// as an S3 bucket or another default model, must not reach the server under test.
const shell = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|HOME|USER|TMPDIR|LANG|LC_\w+|TZ|CI|NODE_\w+|npm_\w+)$/i.test(name)));
const env = {
	...shell,
	DATABASE_URL: e2e.databaseUrl,
	WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
	WORKFLOW_POSTGRES_URL: e2e.databaseUrl,
	WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN: "1",
	BETTER_AUTH_SECRET: "e2e-secret-for-tests-only-0123456789abcdef",
	PORT: String(e2e.port),
	HOST: "127.0.0.1",
	// Every OpenRouter call and every email goes to the fake.
	OPENROUTER_API_KEY: FAKE_KEY,
	OPENROUTER_BASE_URL: `${e2e.fakeUrl}/api`,
	CLOUDFLARE_API_URL: `${e2e.fakeUrl}/client/v4`,
	CLOUDFLARE_ACCOUNT_ID: "fake",
	CLOUDFLARE_EMAIL_TOKEN: "fake",
	PONDER_EMAIL_FROM: "Ponder Chat <ponder@example.com>",
	// Python needs Deno and Pyodide (npm run sandbox:setup). Off, unless E2E_PYTHON=1.
	PONDER_PYTHON: process.env.E2E_PYTHON === "1" ? "on" : "off",
	...(process.env.PONDER_DENO && { PONDER_DENO: process.env.PONDER_DENO }),
	...(process.env.PONDER_DENO_DIR && { PONDER_DENO_DIR: process.env.PONDER_DENO_DIR }),
};

// The workflow's tables. Ponder creates its own when it starts.
const bootstrap = spawnSync("npx", ["--no-install", "bootstrap"], { env, stdio: "inherit" });
if (bootstrap.status !== 0) process.exit(bootstrap.status ?? 1);

const fake = startFake(e2e.fakePort);
const ponder = spawn("node", [".output/server/index.mjs"], { env, stdio: "inherit" });
console.log(`e2e: Ponder on ${e2e.baseUrl}, the fake OpenRouter on ${e2e.fakeUrl}, database ${database}`);

function stop() {
	ponder.kill("SIGTERM");
	fake.close();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
ponder.on("exit", (code) => {
	fake.close();
	process.exit(code ?? 0);
});
