import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Run, WorkflowReadableStream } from "workflow/api";
import { getRun, start } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/errors";
import { chatTurn, type ChatTurn } from "./chat.ts";

/**
 * Workflow DevKit's runtime, as the reply engine uses it (replies.ts, reply.ts,
 * model-attempt.ts): start a reply's run, read its status and its stream, cancel it.
 * Workflow is an outside system with its own world (the Postgres World), so this is the
 * seam a test replaces with a fake.
 *
 * Most failures are defects, thrown at the boundary as the error itself, as before: a run
 * that can't start, or a stream that can't be read, answers 500 or fails the step, which
 * Workflow runs again. A cancel and the end of a stream fail with WorkflowFailed, which
 * their callers log and get past.
 */
export type RunStatus = Awaited<Run<unknown>["status"]> | "gone";

export class WorkflowFailed extends Schema.TaggedError<WorkflowFailed>()("WorkflowFailed", {
	operation: Schema.Literals(["cancel", "end the stream of"]),
	runId: Schema.String,
	cause: Schema.Defect(),
}) {
	override get message() {
		return `Workflow could not ${this.operation} run ${this.runId}.`;
	}
}

export class WorkflowRuns extends Context.Service<
	WorkflowRuns,
	{
		/** Starts a reply's run (chat.ts), and gives its id. */
		readonly start: (turn: ChatTurn) => Effect.Effect<string>;
		/** The run's status, or "gone" when the runtime has no such run. */
		readonly status: (runId: string) => Effect.Effect<RunStatus>;
		readonly cancel: (runId: string, reason: string) => Effect.Effect<void, WorkflowFailed>;
		/** The run's stream, from its first chunk. It has getTailIndex. */
		readonly readable: (runId: string) => Effect.Effect<WorkflowReadableStream<ModelCallStreamPart>>;
		/** Ends the stream of a run that ended without ending it: the error first, when there is one. */
		readonly endStream: (runId: string, error?: string) => Effect.Effect<void, WorkflowFailed>;
	}
>()("ponder/workflow/WorkflowRuns") {}

const make = WorkflowRuns.of({
	start: (turn) => Effect.promise(() => start(chatTurn, [turn])).pipe(Effect.map((run) => run.runId)),
	status: (runId) =>
		Effect.tryPromise({ try: () => getRun(runId).status, catch: (error) => error }).pipe(
			Effect.catch((error) => (WorkflowRunNotFoundError.is(error) ? Effect.succeed("gone" as const) : Effect.die(error))),
		),
	cancel: (runId, reason) =>
		Effect.tryPromise({ try: () => getRun(runId).cancel({ cancelReason: reason }), catch: (cause) => new WorkflowFailed({ operation: "cancel", runId, cause }) }),
	readable: (runId) => Effect.sync(() => getRun(runId).getReadable<ModelCallStreamPart>({ startIndex: 0 })),
	endStream: (runId, error) =>
		Effect.tryPromise({
			try: async () => {
				const writable = getRun(runId).getWritable<ModelCallStreamPart>();
				const writer = writable.getWriter();
				try {
					if (error) await writer.write({ type: "error", error });
				} finally {
					writer.releaseLock();
				}
				await writable.close();
			},
			catch: (cause) => new WorkflowFailed({ operation: "end the stream of", runId, cause }),
		}),
});

export const layer = Layer.succeed(WorkflowRuns, make);
