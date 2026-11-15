import { registerTelemetry, type Telemetry as AiTelemetry } from "ai";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/sql/SqlError";
import { sqlMessage } from "../runtime/Database.ts";
import { tracingState } from "../tracing/state.ts";
import { RunRecorder } from "./run-recorder.ts";
import * as Runs from "./Runs.ts";

/**
 * Telemetry: registers AI SDK telemetry once at server start. Usage and cost per run go
 * to the `runs` table. Chat replies are recorded by their model (workflow/model-attempt.ts,
 * ModelCalls.ts); this records the other calls, such as thread titles.
 */

/** Who a run is for. Telemetry sees these two values of the runtime context and nothing else. */
export type RunContext = { threadId: string; user: string };

export class Telemetry extends Context.Service<
	Telemetry,
	{
		/** Registers the AI SDK's telemetry, and creates the `runs` table. Startup runs it first. */
		readonly setup: Effect.Effect<void, SqlError>;
	}
>()("ponder/telemetry/Telemetry") {}

const make = Effect.gen(function* () {
	const runs = yield* Runs.Runs;
	// The AI SDK calls the recorder from outside Effect: its rows are saved on the services
	// of this layer (the runtime's: its pool, its logger and tracer).
	const run = Effect.runPromiseWith(yield* Effect.context<never>());

	const save = (row: Runs.RunRow) =>
		run(
			runs.insert(row).pipe(
				// Never log the row or the error's query text: keep it to the cause.
				Effect.catchTags({ SqlError: (error) => Effect.logError(`telemetry: could not save run ${row.id}:`, sqlMessage(error)) }),
				Effect.catchCause((cause) => {
					const error = Cause.squash(cause);
					return Effect.logError(`telemetry: could not save run ${row.id}:`, error instanceof Error ? error.message : error);
				}),
			),
		);

	const setup = Effect.gen(function* () {
		// With tracing on (server/tracing/setup.ts), the AI SDK's calls also become spans.
		// registerTelemetry replaces the list, so both are registered here.
		const tracing = tracingState()?.integration;
		const integrations: AiTelemetry[] = [new RunRecorder(save), ...(tracing ? [tracing] : [])];
		yield* Effect.sync(() => registerTelemetry(...integrations));
		yield* runs.migrate;
	});

	return Telemetry.of({ setup });
});

export const layer = Layer.effect(Telemetry, make);

/**
 * Settings for the agent of one run: spread them into the ToolLoopAgent settings.
 * Inputs and outputs are never recorded, so an OpenTelemetry exporter never gets prompts or replies.
 */
export function runTelemetry(run: RunContext, functionId = "chat") {
	return {
		runtimeContext: { ...run } as Record<string, unknown>,
		telemetry: {
			functionId,
			includeRuntimeContext: { threadId: true, user: true },
			recordInputs: false,
			recordOutputs: false,
		},
	};
}
