import type * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as AppLayer from "./layer.ts";

/**
 * The server's one Effect runtime, built from the app's layer (layer.ts) when it is first
 * used, and kept on globalThis. The build has more than one copy of some modules (the
 * routes, the plugins and the workflow's steps each load theirs: .output/server/_chunks/
 * db.mjs, db2.mjs, db3.mjs), and every copy must run on the same services: one database
 * pool, one config. Whichever copy comes first makes it; the copies' layers are the same
 * code. As tracing/state.ts does for the tracer.
 *
 * startup.ts disposes it on SIGTERM, which closes the pool.
 */
type Runtime = ManagedRuntime.ManagedRuntime<AppLayer.Services, AppLayer.Errors>;

const KEY = Symbol.for("ponder.runtime");
const store = globalThis as { [KEY]?: Runtime };

export function runtime(): Runtime {
	return (store[KEY] ??= ManagedRuntime.make(AppLayer.layer));
}

/**
 * Runs an effect from code that is not on Effect yet, such as workflow/replies.ts, and
 * gives its value. A failure rejects with the error itself (the first failure, or else
 * the defect), not a wrapper, so a caller's catch sees what it saw before.
 *
 * The boundary for unconverted callers only: each later phase removes the uses in the
 * files it converts. Routes use route.ts, steps use step.ts, scripts use main.ts.
 */
export function runPromise<A, E>(effect: Effect.Effect<A, E, AppLayer.Services>): Promise<A> {
	return runtime().runPromise(effect);
}

/**
 * Closes every resource of the runtime, such as the database pool, and interrupts what
 * still runs on it. It stays on globalThis, disposed: an effect run after this fails
 * ("ManagedRuntime disposed") instead of opening a new pool while the process stops.
 */
export async function dispose() {
	await store[KEY]?.dispose();
}
