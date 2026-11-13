/**
 * `npm run dev`: Ponder with reloads. `nitro dev` runs the server and restarts it when a
 * file under server/ changes; Vite serves the pages with hot reload and sends the
 * server's paths on to it (vite.config.ts). Open the Vite address, not the server's.
 *
 * Settings come from .env in the repository (gitignored), such as DATABASE_URL and
 * BETTER_AUTH_SECRET. Workflow runs live in that database, as in production (start.sh).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.DATABASE_URL) {
	console.error("DATABASE_URL is not set. Put it in .env (see README.md, Develop).");
	process.exit(1);
}

const env = devEnv(process.env);

// The workflow's tables. It does nothing when they are up to date, so a dev start after an
// upgrade of @workflow/world-postgres cannot miss it.
const bootstrap = spawnSync("node_modules/.bin/bootstrap", { env, stdio: "inherit" });
if (bootstrap.status !== 0) process.exit(bootstrap.status ?? 1);

const children = [
	spawn("node_modules/.bin/nitro", ["dev", "--host", "127.0.0.1", "--port", env.PORT], { env, stdio: "inherit" }),
	spawn("node_modules/.bin/vite", ["--port", env.WEB_PORT, "--strictPort"], { env, stdio: "inherit" }),
];
console.log(`dev: open http://localhost:${env.WEB_PORT} (the server is on ${env.PORT})`);
stopTogether(children);

/** What start.sh sets, with the ports of development. */
function devEnv(base: NodeJS.ProcessEnv) {
	const port = base.PORT ?? "3501";
	const webPort = base.WEB_PORT ?? "5173";
	return {
		...base,
		PORT: port,
		WEB_PORT: webPort,
		WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
		WORKFLOW_POSTGRES_URL: base.WORKFLOW_POSTGRES_URL ?? base.DATABASE_URL,
		WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN: "1",
		// Pages and sign-in links are on Vite's port. Better Auth checks the host against this list.
		PONDER_HOSTS: base.PONDER_HOSTS ?? `localhost:${webPort},127.0.0.1:${webPort}`,
	};
}

/** When one of them stops, stop the other, so that `npm run dev` never leaves one running. */
function stopTogether(processes: ChildProcess[]) {
	const stopAll = () => processes.forEach((child) => child.exitCode === null && child.kill("SIGTERM"));
	for (const child of processes) child.on("exit", (code) => (stopAll(), (process.exitCode ||= code ?? 0)));
	process.on("SIGINT", stopAll);
	process.on("SIGTERM", stopAll);
}
