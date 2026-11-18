import type { IndexRequest, IndexStage, Prepared } from "./Indexer.ts";

/**
 * The steps of the indexing workflow (index-workflow.ts). Each loads its modules inside
 * the step: the workflow imports this file, and workflow code cannot load Node modules.
 * So there is no shared helper here: a plain function would be in the workflow's bundle.
 * The run's root span (`workspace.index`) is sent by the step that ends the run.
 */

export async function prepareIndexStep(request: IndexRequest, runId: string): Promise<Prepared> {
	"use step";
	const { runStep } = await import("../../runtime/step.ts");
	const { endIndexTrace } = await import("../../tracing/reply-trace.ts");
	const Indexer = await import("./Indexer.ts");
	const prepared = await runStep(Indexer.Indexer.use((indexer) => indexer.prepare(request)));
	if (prepared.state !== "chunked") endIndexTrace({ runId, outcome: prepared.state });
	return prepared;
}

export async function embedPassagesStep(request: IndexRequest, batch: number): Promise<void> {
	"use step";
	const { runStep } = await import("../../runtime/step.ts");
	const Indexer = await import("./Indexer.ts");
	// OpenRouter may be busy for a while: wait longer than Workflow's second between tries.
	await runStep(
		Indexer.Indexer.use((indexer) => indexer.embedBatch(request, batch)),
		{ retryable: { EmbeddingFailed: { retryAfter: 15_000 }, EmbeddingTimedOut: { retryAfter: 15_000 } }, fatal: ["NoOpenRouterKey", "UnreadableSecret"] },
	);
}
embedPassagesStep.maxRetries = 5;

export async function finishIndexStep(request: IndexRequest, runId: string): Promise<void> {
	"use step";
	const { runStep } = await import("../../runtime/step.ts");
	const { endIndexTrace } = await import("../../tracing/reply-trace.ts");
	const Indexer = await import("./Indexer.ts");
	const outcome = await runStep(Indexer.Indexer.use((indexer) => indexer.finish(request)));
	endIndexTrace({ runId, outcome });
}

/** A step failed after its retries: the document is Failed, with the step and what its error said. */
export async function failIndexStep(request: IndexRequest, stage: IndexStage, error: string, runId: string): Promise<void> {
	"use step";
	const { runStep } = await import("../../runtime/step.ts");
	const { endIndexTrace } = await import("../../tracing/reply-trace.ts");
	const Indexer = await import("./Indexer.ts");
	await runStep(Indexer.Indexer.use((indexer) => indexer.fail(request, stage, `${error} Try again.`)));
	endIndexTrace({ runId, outcome: "failed" });
}
