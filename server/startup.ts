import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as AdminEvents from "./admin/AdminEvents.ts";
import * as Auth from "./auth/Auth.ts";
import * as SignInProviders from "./auth/SignInProviders.ts";
import * as Branding from "./branding/Branding.ts";
import * as Credits from "./credits/Credits.ts";
import * as Files from "./files.ts";
import * as Invites from "./people/Invites.ts";
import * as Memory from "./memory.ts";
import * as Sandbox from "./python/pyodide.ts";
import * as PythonState from "./python/state.ts";
import * as ConnectorStore from "./mcp/ConnectorStore.ts";
import * as CompactionStore from "./compaction/store.ts";
import { pgCode, sqlMessage } from "./runtime/Database.ts";
import { dispose, runPromise, runtime } from "./runtime/runtime.ts";
import * as Secrets from "./secrets/Secrets.ts";
import * as Skills from "./skills.ts";
import { seedStandardSkills } from "./standard-skills.ts";
import * as Threads from "./threads/Threads.ts";
import * as Telemetry from "./telemetry/Telemetry.ts";
import * as Teams from "./teams/Teams.ts";
import { stopTracing } from "./tracing/setup.ts";
import { toolApprovalSecret } from "./workflow/approval-secret.ts";
import * as ApprovalUses from "./workflow/approval-uses.ts";
import * as ThreadRuns from "./workflow/runs.ts";
import * as WebBuild from "./web-build.ts";
import * as OpenRouter from "./openrouter/OpenRouter.ts";
import * as Documents from "./workspaces/documents/Documents.ts";
import * as Workspaces from "./workspaces/Workspaces.ts";

/**
 * What the server does once when it starts, before it answers requests: create and
 * update its tables, check the Python sandbox, and start the Postgres World's worker,
 * which picks up the workflow runs that a stop or a crash left in the middle.
 *
 * A Nitro plugin's code (plugins/startup.ts), so a boundary: it runs each part on the
 * app's runtime (runtime/runtime.ts), and after SIGTERM disposes it.
 */
export async function startup() {
	// A failed migration still settles Python's check, so the routes that wait on it don't hang.
	try {
		await runPromise(migrateAll);
	} catch (error) {
		await runtime().runPromiseExit(Sandbox.Sandbox.use((sandbox) => sandbox.turnOff));
		throw error;
	}

	// The worker's lock is held on a connection of its own, until the stop below releases it.
	const lock = await runPromise(Scope.make());
	await runPromise(becomeTheOnlyWorker.pipe(Scope.provide(lock)));
	await runPromise(releaseDeadWorkers);
	// Before the worker resumes the runs a stop left: documents whose passages another embedding model made are
	// indexed again with a new generation, so the run of a document that was Reading can't fail it (Documents.ts).
	await runPromise(
		Documents.Documents.use((documents) => documents.reindexOutdated).pipe(
			Effect.catchTags({ SqlError: (error) => Effect.logError("workspace documents: could not check for documents to index again:", sqlMessage(error)) }),
		),
	);
	const { getWorld } = await import("workflow/runtime");
	const world = await getWorld();
	await world.start?.();
	// Loaded here: replies.ts, which the sweep runs, loads the workflow.
	const { sweeps } = await import("./workflow/sweep.ts");
	const sweeping = runtime().runFork(sweeps);
	stopCleanly(world, {
		stopSweeps: () => runPromise(Fiber.interrupt(sweeping)),
		releaseLock: () => runPromise(Scope.close(lock, Exit.void)),
	});
	await runPromise(Effect.gen(function* () {
		const python = yield* Sandbox.Sandbox.use((sandbox) => sandbox.ready);
		yield* Effect.log(`Ponder Chat is ready. Python is ${python ? "on" : "off"}.`);
	}));
}

/**
 * The tables, one after another, in this order. It is the first effect the runtime runs,
 * so it builds the runtime (runtime/runtime.ts).
 */
const migrateAll = Effect.gen(function* () {
	// First, so a missing web build is said before anything else.
	yield* WebBuild.WebBuild.use((build) => build.check);
	const threads = yield* Threads.Threads;
	// OpenRouter's list of private models, read now, in the background: the chat page's first
	// screen shows them without waiting (boot-page.ts).
	yield* OpenRouter.OpenRouter.use((openRouter) => openRouter.modelsWithZdrNow);
	yield* Telemetry.Telemetry.use((telemetry) => telemetry.setup);
	yield* threads.migrate;
	// After threads: its tables reference them.
	yield* CompactionStore.CompactionStore.use((store) => store.migrate);
	// Before Auth: Better Auth is made with the sign-in providers that are set up.
	yield* SignInProviders.SignInProviders.use((providers) => providers.migrate);
	yield* Auth.Auth.use((auth) => auth.migrate);
	// After Auth and Threads: its tables reference users, and threads.workspace_id references it.
	yield* Workspaces.Workspaces.use((workspaces) => workspaces.migrate);
	yield* Files.Files.use((files) => files.migrate);
	yield* Credits.Credits.use((credits) => credits.migrate);
	yield* Invites.Invites.use((invites) => invites.migrate);
	// After Auth, Workspaces and Invites: its tables reference users and workspaces, and it adds a column to allowed_emails.
	yield* Teams.Teams.use((teams) => teams.migrate);
	yield* AdminEvents.AdminEvents.use((events) => events.migrate);
	yield* Secrets.Secrets.use((secrets) => secrets.migrate);
	yield* Branding.Branding.use((branding) => branding.migrate);
	yield* ConnectorStore.ConnectorStore.use((store) => store.migrate);
	yield* Skills.Skills.use((skills) => skills.migrate);
	yield* seedStandardSkills();
	// The secret that tool approvals are signed with (workflow/approval-secret.ts): without it, the server does not start.
	yield* toolApprovalSecret;
	yield* PythonState.PythonState.use((states) => states.migrate);
	yield* ThreadRuns.ThreadRuns.use((runs) => runs.migrate);
	yield* ApprovalUses.ApprovalUses.use((uses) => uses.migrate);
	yield* Memory.Memory.use((memory) => memory.setup);
	yield* Sandbox.Sandbox.use((sandbox) => sandbox.check);
});

/**
 * Waits until no other Ponder Chat server runs workflow workers on this database, and then
 * holds a lock that says so for as long as this process lives. Postgres frees the lock
 * when the process's connection closes, even after a crash. A new server started while
 * the old one is still stopping waits here, so the two never run the same step at once,
 * and releaseDeadWorkers below can only release the jobs of stopped servers.
 *
 * The connection is reserved from the pool for as long as the scope is open: one of its 10.
 */
const LockRow = Schema.Struct({ locked: Schema.Boolean });

const becomeTheOnlyWorker = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const connection = yield* sql.reserve;
	const key = 7_316_420_901;
	const rows = yield* connection.execute("select pg_try_advisory_lock($1) as locked", [key], undefined);
	const { locked } = yield* Schema.decodeUnknownEffect(LockRow)(rows[0]).pipe(Effect.orDie);
	if (locked) return;
	yield* Effect.log("workflow: waiting for the previous server to stop");
	yield* connection.execute("select pg_advisory_lock($1)", [key], undefined);
});

/**
 * Frees the jobs that a crashed server left locked. graphile-worker treats a lock as stale
 * only after 4 hours, so without this a reply cut off by a crash (or a SIGKILL) waits 4
 * hours to go on. A clean stop (SIGTERM) releases its jobs itself.
 *
 * becomeTheOnlyWorker makes this safe: once it returns, every lock belongs to a process
 * that is gone. With several worker processes, this would instead have to unlock only
 * the workers that stopped sending a heartbeat.
 */
const releaseDeadWorkers = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const [row] = yield* sql<{ workers: string[] | null }>`
		select array_agg(distinct locked_by) as workers from graphile_worker._private_jobs where locked_by is not null`.pipe(
		Effect.catchTags({
			SqlError: (error) =>
				// On the first start the worker has not made its schema yet, so there is nothing to release.
				// Any other failure leaves a stopped worker's jobs locked, and their replies wait: logged.
				Effect.as(
					["42P01", "3F000"].includes(pgCode(error) ?? "") ? Effect.void : Effect.logError("workflow: could not look for the jobs of stopped workers:", sqlMessage(error)),
					[{ workers: null }],
				),
		}),
	);
	const workers = row?.workers;
	if (!workers?.length) return;
	yield* sql`select graphile_worker.force_unlock_workers(${workers}::text[])`;
	yield* Effect.log(`workflow: released the jobs of ${workers.length} stopped worker(s)`);
});

/**
 * On SIGTERM (a deploy, `systemctl stop`) or SIGINT: stop the worker, which releases its
 * jobs, close the database, and exit. Without this the process stays up after Nitro closes
 * its port, because the worker and the pools keep it alive, and systemd waits its full
 * stop timeout before it kills it. A reply in the middle of a step goes on in the next
 * server: the step runs again (start.sh sets WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN,
 * so the worker leaves the process to this code).
 *
 * The process's own code, around the runtime: the 10-second deadline and the last two
 * lines are a plain timer and the console, because the runtime is disposed on the way.
 */
function stopCleanly(world: { close?: () => Promise<void> }, { stopSweeps, releaseLock }: { stopSweeps: () => Promise<unknown>; releaseLock: () => Promise<void> }) {
	let stopping = false;
	const stop = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		setTimeout(() => {
			console.warn("Stopping took over 10 seconds; exiting anyway.");
			process.exit(0);
		}, 10_000);
		try {
			await runPromise(Effect.log(`${signal}: stopping the workflow worker`));
			// The sweep needs the database, which closes below.
			await stopSweeps();
			await world.close?.();
			// The worker's lock goes back to the pool, then the runtime closes the pool, and with it the lock (runtime/runtime.ts).
			await releaseLock();
			await dispose();
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
