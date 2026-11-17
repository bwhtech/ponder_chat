import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { getRun, start } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/errors";
import type { IndexRequest } from "./Indexer.ts";
import { indexDocument } from "./index-workflow.ts";

/**
 * Starts a document's indexing run on Workflow DevKit (index-workflow.ts), and tells whether
 * one is still going. Workflow is an outside system with its own world, so this is the seam
 * a test replaces: the tests run the Indexer itself.
 */
export class IndexNotStarted extends Schema.TaggedError<IndexNotStarted>()("IndexNotStarted", {
	documentId: Schema.String,
	cause: Schema.Defect(),
}) {
	override get message() {
		return "Indexing could not start.";
	}
}

/** "live" while the run waits or runs; "ended" once it finished, failed, was cancelled, or is unknown. */
export type IndexRunStatus = "live" | "ended";

export class IndexRuns extends Context.Service<
	IndexRuns,
	{
		/** Starts the run, and gives its id. */
		readonly start: (request: IndexRequest) => Effect.Effect<string, IndexNotStarted>;
		readonly status: (runId: string) => Effect.Effect<IndexRunStatus>;
	}
>()("ponder/workspaces/IndexRuns") {}

export const layer = Layer.succeed(
	IndexRuns,
	IndexRuns.of({
		start: (request) =>
			Effect.tryPromise({ try: () => start(indexDocument, [request]), catch: (cause) => new IndexNotStarted({ documentId: request.documentId, cause }) }).pipe(
				Effect.map((run) => run.runId),
			),
		status: (runId) =>
			Effect.tryPromise({ try: () => getRun(runId).status, catch: (error) => error }).pipe(
				Effect.map((status): IndexRunStatus => (status === "pending" || status === "running" ? "live" : "ended")),
				Effect.catch((error) => (WorkflowRunNotFoundError.is(error) ? Effect.succeed("ended" as const) : Effect.die(error))),
			),
	}),
);
