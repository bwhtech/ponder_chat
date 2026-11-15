import * as Layer from "effect/Layer";
import * as PonderConfig from "../config.ts";
import * as Threads from "../threads/Threads.ts";
import * as Logger from "../tracing/Logger.ts";
import * as Tracing from "../tracing/Tracing.ts";
import * as Database from "./Database.ts";

/**
 * The app's layer: every service the server runs on, built once by runtime.ts. A new
 * service goes here, with what it needs provided below it.
 *
 * Tracing and the logger come last, so every layer above, and every effect the runtime
 * runs, logs and traces through them.
 */
export const layer = Threads.layer.pipe(
	Layer.provideMerge(Database.layer),
	Layer.provideMerge(PonderConfig.layer),
	Layer.provideMerge(Layer.mergeAll(Tracing.layer, Logger.layer)),
);

/** What an effect run by the runtime (route, runStep, runMain, runPromise) may require. */
export type Services = Layer.Success<typeof layer>;

/** How building the layer can fail: a bad config value, or the database client's setup. */
export type Errors = Layer.Error<typeof layer>;
