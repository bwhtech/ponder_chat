import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { start } from "workflow/api";
import type { IndexRequest } from "./Indexer.ts";
import { indexDocument } from "./index-workflow.ts";

/**
 * Starts a document's indexing run on Workflow DevKit (index-workflow.ts). Workflow is an
 * outside system with its own world, so this is the seam a test replaces: the tests run
 * the Indexer itself.
 */
export class IndexNotStarted extends Schema.TaggedError<IndexNotStarted>()("IndexNotStarted", {
	documentId: Schema.String,
	cause: Schema.Defect(),
}) {
	override get message() {
		return "Indexing could not start.";
	}
}

export class IndexRuns extends Context.Service<
	IndexRuns,
	{
		readonly start: (request: IndexRequest) => Effect.Effect<void, IndexNotStarted>;
	}
>()("ponder/workspaces/IndexRuns") {}

export const layer = Layer.succeed(
	IndexRuns,
	IndexRuns.of({
		start: (request) =>
			Effect.tryPromise({ try: () => start(indexDocument, [request]), catch: (cause) => new IndexNotStarted({ documentId: request.documentId, cause }) }).pipe(Effect.asVoid),
	}),
);
