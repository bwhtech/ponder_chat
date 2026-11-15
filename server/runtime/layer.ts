import * as Layer from "effect/Layer";
import * as PonderConfig from "../config.ts";
import * as Mailer from "../email/Mailer.ts";
import * as ObjectStore from "../files/ObjectStore.ts";
import * as AutoRouter from "../models/AutoRouter.ts";
import * as Models from "../models/Models.ts";
import * as NetGuard from "../net/NetGuard.ts";
import * as Notify from "../notify/Notify.ts";
import * as OpenRouter from "../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import * as Secrets from "../secrets/Secrets.ts";
import * as Settings from "../settings/Settings.ts";
import * as ModelCalls from "../telemetry/ModelCalls.ts";
import * as Runs from "../telemetry/Runs.ts";
import * as Telemetry from "../telemetry/Telemetry.ts";
import * as Threads from "../threads/Threads.ts";
import * as Logger from "../tracing/Logger.ts";
import * as Tracing from "../tracing/Tracing.ts";
import * as Database from "./Database.ts";
import * as Http from "./Http.ts";

/**
 * The app's layer: every service the server runs on, built once by runtime.ts. A new
 * service goes here, with what it needs provided below it.
 *
 * Tracing and the logger come last, so every layer above, and every effect the runtime
 * runs, logs and traces through them.
 */
export const layer = Layer.mergeAll(Threads.layer, AutoRouter.layer, ModelCalls.layer, Telemetry.layer).pipe(
	Layer.provideMerge(Layer.mergeAll(Models.layer, OpenRouterKey.layer, Runs.layer)),
	Layer.provideMerge(Layer.mergeAll(OpenRouter.layer, Secrets.layer, Settings.layer, NetGuard.layer, ObjectStore.layer, Mailer.layer, Notify.layer)),
	Layer.provideMerge(Layer.mergeAll(Database.layer, Http.layer)),
	Layer.provideMerge(PonderConfig.layer),
	Layer.provideMerge(Layer.mergeAll(Tracing.layer, Logger.layer)),
);

/** What an effect run by the runtime (route, runStep, runMain, runPromise) may require. */
export type Services = Layer.Success<typeof layer>;

/** How building the layer can fail: a bad config value, or the database client's setup. */
export type Errors = Layer.Error<typeof layer>;
