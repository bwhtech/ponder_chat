import postgres from "postgres";

/**
 * TEMPORARY, until Phase 3 of docs/effect-migration.md removes it with postgres.js: the
 * postgres.js pool of the modules that are not on Effect yet (memory, telemetry, the
 * connector store, admin, credits, startup's worker lock, the scripts...). Each phase
 * moves its modules to Effect's PgClient (server/runtime/Database.ts) and drops their
 * import of this. Do not add new uses. The threads table is in server/threads/Threads.ts.
 */
// Notices are "already exists, skipping" from the migrations.
export const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
