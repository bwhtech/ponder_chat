import { getWorkflowMetadata } from "workflow";
import type { IndexRequest, IndexStage } from "./Indexer.ts";
import { embedPassagesStep, failIndexStep, finishIndexStep, prepareIndexStep } from "./index-steps.ts";

/**
 * Indexes one workspace document, as a durable workflow run (Indexer.ts does the work).
 * Each step is recorded in Postgres when it ends: after a crash, the run goes on from the
 * first step without a result, so a large text does not embed its first batches again.
 *
 * A step that fails after its retries fails the document, with the step and the error;
 * a document that was deleted, or indexed again meanwhile, ends the run quietly.
 *
 * Workflow code: plain TypeScript at the top level, no Effect and no Node modules.
 */
export async function indexDocument(request: IndexRequest) {
	"use workflow";

	const { workflowRunId } = getWorkflowMetadata();
	let stage: IndexStage = "parse";
	try {
		const prepared = await prepareIndexStep(request, workflowRunId);
		if (prepared.state !== "chunked") return;
		stage = "embed";
		for (let batch = 0; batch < prepared.batches; batch++) await embedPassagesStep(request, batch);
		stage = "finish";
		await finishIndexStep(request, workflowRunId);
	} catch (error) {
		await failIndexStep(request, stage, error instanceof Error ? error.message : "The step failed.", workflowRunId);
	}
}
