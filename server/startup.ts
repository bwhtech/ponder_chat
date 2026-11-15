import { hkdfSync } from "node:crypto";
import * as Effect from "effect/Effect";
import { migrateAdminEvents } from "./admin-events.ts";
import { migrateAuth } from "./auth.ts";
import { migrateCredits } from "./credits.ts";
import { sql } from "./db.ts";
import { migrateFiles } from "./files.ts";
import { migrateInvites } from "./invites.ts";
import { setupMemory } from "./memory.ts";
import { checkSandbox } from "./python/pyodide.ts";
import { migratePythonState } from "./python/state.ts";
import { migrateConnectors } from "./mcp/store.ts";
import { migrateCompaction } from "./compaction/store.ts";
import { dispose, runPromise } from "./runtime/runtime.ts";
import * as Secrets from "./secrets/Secrets.ts";
import { migrateSkills } from "./skills.ts";
import { seedStandardSkills } from "./standard-skills.ts";
import * as Threads from "./threads/Threads.ts";
import { TOOL_APPROVAL_SECRET_ENV } from "./workflow/approval-secret.ts";
import * as Telemetry from "./telemetry/Telemetry.ts";
import { stopTracing } from "./tracing/setup.ts";
import { migrateApprovalUses } from "./workflow/approval-uses.ts";
import { migrateThreadRuns } from "./workflow/runs.ts";
import { checkWebBuild } from "./web-build.ts";
import * as OpenRouter from "./openrouter/OpenRouter.ts";

/**
 * What the server does once when it starts, before it answers requests: create and
 * update its tables, check the Python sandbox, and start the Postgres World's worker,
 * which picks up the workflow runs that a stop or a crash left in the middle.
 */
let resolvePython: (ready: boolean) => void;
/** Python is on only when the sandbox is set up (sandbox/pyodide/setup.sh) and Deno is found. */
export const pythonReady = new Promise<boolean>((resolve) => (resolvePython = resolve));

export async function startup() {
	checkWebBuild();
	// A failed migration still settles pythonReady, so the routes that wait on it don't hang.
	try {
		await runPromise(migrateAll);
	} catch (error) {
		resolvePython(false);
		throw error;
	}

	await becomeTheOnlyWorker();
	await releaseDeadWorkers();
	const { getWorld } = await import("workflow/runtime");
	const world = await getWorld();
	await world.start?.();
	// Loaded here: replies.ts imports this file.
	const { startSweeps, stopSweeps } = await import("./workflow/sweep.ts");
	stopCleanly(world, stopSweeps);
	startSweeps();
	console.log(`Ponder Chat is ready. Python is ${(await pythonReady) ? "on" : "off"}.`);
}

/**
 * The tables, one after another, in this order. It is the first effect the runtime runs,
 * so it builds the runtime (runtime/runtime.ts). The modules not on Effect yet run as they
 * are, in Effect.promise: their failure is a defect, which runPromise throws as the error
 * itself, as before. Later phases put each module's own Effect in its place.
 */
const migrateAll = Effect.gen(function* () {
	const threads = yield* Threads.Threads;
	// OpenRouter's list of private models, read now, in the background: the chat page's first
	// screen shows them without waiting (boot-page.ts).
	yield* OpenRouter.OpenRouter.use((openRouter) => openRouter.modelsWithZdrNow);
	yield* Telemetry.Telemetry.use((telemetry) => telemetry.setup);
	yield* threads.migrate;
	// After threads: its tables reference them.
	yield* Effect.promise(() => migrateCompaction());
	yield* Effect.promise(() => migrateAuth());
	yield* Effect.promise(() => migrateFiles());
	yield* Effect.promise(() => migrateCredits());
	yield* Effect.promise(() => migrateInvites());
	yield* Effect.promise(() => migrateAdminEvents());
	yield* Secrets.Secrets.use((secrets) => secrets.migrate);
	yield* Effect.promise(() => migrateConnectors());
	yield* Effect.promise(() => migrateSkills());
	yield* Effect.promise(() => seedStandardSkills());
	yield* Effect.sync(setToolApprovalSecret);
	yield* Effect.promise(() => migratePythonState());
	yield* Effect.promise(() => migrateThreadRuns());
	yield* Effect.promise(() => migrateApprovalUses());
	yield* Effect.promise(() => setupMemory());
	resolvePython(yield* Effect.promise(() => checkSandbox()));
});

/**
 * Waits until no other Ponder Chat server runs workflow workers on this database, and then
 * holds a lock that says so for as long as this process lives. Postgres frees the lock
 * when the process's connection closes, even after a crash. A new server started while
 * the old one is still stopping waits here, so the two never run the same step at once,
 * and releaseDeadWorkers below can only release the jobs of stopped servers.
 */
async function becomeTheOnlyWorker() {
	const connection = await sql.reserve();
	const key = 7_316_420_901;
	const [first] = await connection<{ locked: boolean }[]>`select pg_try_advisory_lock(${key}) as locked`;
	if (first.locked) return;
	console.log("workflow: waiting for the previous server to stop");
	await connection`select pg_advisory_lock(${key})`;
}

/**
 * Frees the jobs that a crashed server left locked. graphile-worker treats a lock as stale
 * only after 4 hours, so without this a reply cut off by a crash (or a SIGKILL) waits 4
 * hours to go on. A clean stop (SIGTERM) releases its jobs itself.
 *
 * becomeTheOnlyWorker makes this safe: once it returns, every lock belongs to a process
 * that is gone. With several worker processes, this would instead have to unlock only
 * the workers that stopped sending a heartbeat.
 */
async function releaseDeadWorkers() {
	const [row] = await sql<{ workers: string[] | null }[]>`
		select array_agg(distinct locked_by) as workers from graphile_worker._private_jobs where locked_by is not null`.catch((error) => {
		// On the first start the worker has not made its schema yet, so there is nothing to release.
		// Any other failure leaves a stopped worker's jobs locked, and their replies wait: logged.
		if (!["42P01", "3F000"].includes((error as { code?: string }).code ?? "")) console.error("workflow: could not look for the jobs of stopped workers:", error instanceof Error ? error.message : error);
		return [{ workers: null }];
	});
	if (!row?.workers?.length) return;
	await sql`select graphile_worker.force_unlock_workers(${row.workers})`;
	console.log(`workflow: released the jobs of ${row.workers.length} stopped worker(s)`);
}

/**
 * On SIGTERM (a deploy, `systemctl stop`) or SIGINT: stop the worker, which releases its
 * jobs, close the database, and exit. Without this the process stays up after Nitro closes
 * its port, because the worker and the pools keep it alive, and systemd waits its full
 * stop timeout before it kills it. A reply in the middle of a step goes on in the next
 * server: the step runs again (start.sh sets WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN,
 * so the worker leaves the process to this code).
 */
function stopCleanly(world: { close?: () => Promise<void> }, stopSweeps: () => void) {
	let stopping = false;
	const stop = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		console.log(`${signal}: stopping the workflow worker`);
		setTimeout(() => {
			console.warn("Stopping took over 10 seconds; exiting anyway.");
			process.exit(0);
		}, 10_000);
		try {
			// The sweep needs the database, which closes below.
			stopSweeps();
			await world.close?.();
			// The Effect runtime's pool (runtime/runtime.ts), then db.ts's, which also holds the worker lock.
			await dispose();
			await sql.end({ timeout: 3 });
			// The spans of the steps that just stopped, and any still waiting in the batch.
			// Last, and for 2 seconds at most, so a collector that is down never costs the database its clean stop.
			await stopTracing();
		} catch (error) {
			console.error("Stopping:", error instanceof Error ? error.message : error);
		}
		process.exit(0);
	};
	process.once("SIGTERM", () => void stop("SIGTERM"));
	process.once("SIGINT", () => void stop("SIGINT"));
}

/** The secret that tool approvals are signed with (workflow/approval-secret.ts), from BETTER_AUTH_SECRET unless it is set. */
function setToolApprovalSecret() {
	if (process.env[TOOL_APPROVAL_SECRET_ENV]) return;
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) throw new Error("BETTER_AUTH_SECRET is not set.");
	process.env[TOOL_APPROVAL_SECRET_ENV] = Buffer.from(hkdfSync("sha256", secret, "ponder-chat", "tool approvals v1", 32)).toString("base64url");
}
