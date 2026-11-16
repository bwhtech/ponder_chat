/**
 * Ponder's build (.output/, from `npm run build`) as the tests run it: on a new, empty
 * database, with every OpenRouter call and email sent to the fake. start.ts starts the
 * server that most tests share; each durability file starts its own, because it stops it (durability.ts).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import postgres from "postgres";
import { FAKE_KEY } from "./fake/server.ts";
import { e2e } from "./env.ts";

/** Drops the database and makes it again, with the workflow's tables. Its name must end in "_e2e". */
export async function newDatabase(databaseUrl: string) {
	const database = new URL(databaseUrl).pathname.slice(1);
	if (!database.endsWith("_e2e")) throw new Error(`Refusing to reset "${database}": the test database's name must end in "_e2e". Each run drops it.`);
	const server = new URL(databaseUrl);
	server.pathname = "/postgres";
	const admin = postgres(server.href, { onnotice: () => {} });
	await admin.unsafe(`drop database if exists "${database}" with (force)`);
	await admin.unsafe(`create database "${database}"`);
	await admin.end();
	// The workflow's tables. Ponder creates its own when it starts.
	const bootstrap = spawnSync("npx", ["--no-install", "bootstrap"], { env: ponderEnv(e2e.port, databaseUrl), stdio: "inherit" });
	if (bootstrap.status !== 0) throw new Error(`npx bootstrap failed with status ${bootstrap.status}.`);
}

/** The environment of a Ponder under test. */
export function ponderEnv(port: number, databaseUrl: string): NodeJS.ProcessEnv {
	// Only what Node and npm need from this shell. A shell with Ponder's own settings, such
	// as an S3 bucket or another default model, must not reach the server under test.
	const shell = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|HOME|USER|TMPDIR|LANG|LC_\w+|TZ|CI|NODE_\w+|npm_\w+)$/i.test(name)));
	return {
		...shell,
		DATABASE_URL: databaseUrl,
		WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
		WORKFLOW_POSTGRES_URL: databaseUrl,
		WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN: "1",
		BETTER_AUTH_SECRET: "e2e-secret-for-tests-only-0123456789abcdef",
		PORT: String(port),
		HOST: "127.0.0.1",
		// Every OpenRouter call and every email goes to the fake.
		OPENROUTER_API_KEY: FAKE_KEY,
		OPENROUTER_BASE_URL: `${e2e.fakeUrl}/api`,
		CLOUDFLARE_API_URL: `${e2e.fakeUrl}/client/v4`,
		CLOUDFLARE_ACCOUNT_ID: "fake",
		CLOUDFLARE_EMAIL_TOKEN: "fake",
		PONDER_EMAIL_FROM: "Ponder Chat <ponder@example.com>",
		// The test MCP servers are on 127.0.0.1 and use http. This lets connectors reach them (server/net/NetGuard.ts).
		MCP_ALLOW_PRIVATE_NETWORKS: "1",
		// The sweep (server/workflow/sweep.ts) every second, so tests see its work at once.
		PONDER_SWEEP_SECONDS: "1",
		// Python needs Deno and Pyodide (npm run sandbox:setup). Off, unless E2E_PYTHON=1.
		PONDER_PYTHON: process.env.E2E_PYTHON === "1" ? "on" : "off",
		// Traces go to the fake, which tracing.spec.ts reads, or to E2E_OTEL_ENDPOINT, such as a
		// local Jaeger (README, "Tracing"). Sent every 100 ms, so a test does not wait long.
		OTEL_EXPORTER_OTLP_ENDPOINT: process.env.E2E_OTEL_ENDPOINT ?? e2e.fakeUrl,
		OTEL_BSP_SCHEDULE_DELAY: "100",
		...(process.env.PONDER_DENO && { PONDER_DENO: process.env.PONDER_DENO }),
		...(process.env.PONDER_DENO_DIR && { PONDER_DENO_DIR: process.env.PONDER_DENO_DIR }),
	};
}

/** A Ponder server that a test can stop, as a crash (SIGKILL) or a deploy (SIGTERM) does, and start again. */
export class PonderServer {
	private process: ChildProcess | undefined;

	constructor(
		private readonly port: number,
		private readonly databaseUrl: string,
	) {}

	get url() {
		return `http://127.0.0.1:${this.port}`;
	}

	/** Starts the server, and waits until it says it is ready. */
	async start() {
		const ponder = spawn("node", [".output/server/index.mjs"], { env: ponderEnv(this.port, this.databaseUrl), stdio: ["ignore", "pipe", "pipe"] });
		this.process = ponder;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Ponder on ${this.url} did not start in 60 seconds.`)), 60_000);
			ponder.stdout!.on("data", (data: Buffer) => {
				process.stdout.write(prefixed(data, this.port));
				if (data.toString().includes("Ponder Chat is ready")) {
					clearTimeout(timer);
					resolve();
				}
			});
			ponder.stderr!.on("data", (data: Buffer) => process.stderr.write(prefixed(data, this.port)));
			ponder.once("exit", (code) => reject(new Error(`Ponder on ${this.url} stopped with code ${code} before it was ready.`)));
		});
	}

	/** Stops the server with `signal`, and waits until the process is gone. */
	async stop(signal: NodeJS.Signals = "SIGTERM") {
		const ponder = this.process;
		if (!ponder || ponder.exitCode !== null || ponder.signalCode !== null) return;
		const exited = new Promise((resolve) => ponder.once("exit", resolve));
		ponder.kill(signal);
		await exited;
	}
}

function prefixed(data: Buffer, port: number) {
	return data
		.toString()
		.split("\n")
		.filter(Boolean)
		.map((line) => `[ponder ${port}] ${line}\n`)
		.join("");
}
