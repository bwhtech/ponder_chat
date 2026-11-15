import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { CompactionState, CompactRequest, CompactResult } from "../compaction/compaction.ts";
import type { RunPythonInput } from "../python/schema.ts";
import type { WebFetchInput, WebSearchInput } from "../search/schema.ts";
import type { ActiveSkill } from "../skills.ts";
import { CONTEXT_STEP_RETRIES, contextStep } from "./context-step.ts";
import { COMPACTION_MARKER } from "./reply-chunks.ts";
import type { Continued } from "./runs.ts";
import type { ThreadContext } from "./thread-messages.ts";

/**
 * The chat workflow's steps. Each is recorded in Postgres when it finishes; after a
 * restart the workflow replays and skips the steps that have a result. Steps load their
 * modules inside the step, because the workflow imports this file and workflow code
 * cannot load Node modules (the database, files, the sandbox).
 */

/**
 * The thread as the model reads it (thread-messages.ts), with its saved summary in place
 * of the messages it covers, and what compaction decides from: the estimate, the
 * thread's measured ratio and the model's window. A step, so a replay reads the same.
 *
 * A reply that reads a saved summary says so to the page, as the reply that wrote it did,
 * so the divider stays after a Retry of that reply.
 */
export async function loadModelMessages(
	writable: WritableStream<ModelCallStreamPart>,
	threadId: string,
	owner: string,
	modelId: string,
	recalled: string,
	skills: ActiveSkill[] = [],
	/** The <connectors> note (mcp/catalog-note.ts). */
	connectors = "",
	/** A reply that keeps its reasoning (context.ts). */
	keepReasoningOf?: string,
): Promise<ThreadContext> {
	"use step";
	const { runStep } = await import("../runtime/step.ts");
	const { loadThreadContext } = await import("./thread-messages.ts");
	const context = await runStep(loadThreadContext(threadId, { owner, modelId, recalled, skills, connectors, keepReasoningOf }));
	if (context.through) await writeCompactionState(writable, { state: "done", through: context.through });
	return context;
}

/** How many times compaction runs again after it fails. On the last attempt it leaves the old messages out instead of failing. */
export const COMPACT_RETRIES = 2;

/**
 * Summarizes the older part of a long thread (server/compaction/), and tells the page
 * while it does: the marker becomes a `data-compaction` part (reply.ts). A step, so a
 * replay never runs the summarizer twice.
 */
export async function compactStep(writable: WritableStream<ModelCallStreamPart>, request: CompactRequest): Promise<CompactResult> {
	"use step";
	const { getStepMetadata } = await import("workflow");
	const { runStep } = await import("../runtime/step.ts");
	const { compact } = await import("../compaction/compact.ts");
	const { attempt } = getStepMetadata();
	return runStep(compact(request, { lastAttempt: attempt > COMPACT_RETRIES, status: (state) => writeCompactionState(writable, state) }));
}
compactStep.maxRetries = COMPACT_RETRIES;

/** The compaction status for the page (reply-chunks.ts). Called inside steps. */
async function writeCompactionState(writable: WritableStream<ModelCallStreamPart>, state: CompactionState) {
	const writer = writable.getWriter();
	try {
		await writer.write({ type: "raw", rawValue: { [COMPACTION_MARKER]: state } });
		// Each model call starts with reset-step, which drops the parts of the step it is in.
		// So the status ends a step of its own, as the agent does between its steps.
		if (state.state !== "running") for (const type of ["finish-step", "start-step"]) await writer.write({ type } as unknown as ModelCallStreamPart);
	} finally {
		writer.releaseLock();
	}
}

/** Memory's guidance for the instructions, and what it recalls for the person's latest message. */
export async function recallMemoryStep(threadId: string, owner: string): Promise<{ guidance: string; recalled: string }> {
	"use step";
	return contextStep("memory", `thread ${threadId}`, async () => {
		const { runStep } = await import("../runtime/step.ts");
		const Threads = await import("../threads/Threads.ts");
		const Memory = await import("../memory.ts");
		const messages = await runStep(Threads.Threads.use((threads) => threads.load(threadId)));
		return runStep(Memory.Memory.use((memory) => memory.forRun({ threadId, user: owner }, messages)));
	});
}
recallMemoryStep.maxRetries = CONTEXT_STEP_RETRIES;

export async function runPythonStep(input: RunPythonInput, threadId: string, owner: string) {
	"use step";
	const { runStep } = await import("../runtime/step.ts");
	const RunPython = await import("../python/tool.ts");
	return runStep(RunPython.RunPython.use((python) => python.execute(input, { threadId, owner })));
}

export async function webSearchStep(input: WebSearchInput, threadId: string, owner: string) {
	"use step";
	const { runStep } = await import("../runtime/step.ts");
	const { executeWebSearch } = await import("../search/tool.ts");
	return runStep(executeWebSearch(input, { threadId, owner }));
}

/** The pages web_fetch may read in this thread without asking the person (search/trusted-pages.ts). */
export async function trustedPagesStep(threadId: string): Promise<string[]> {
	"use step";
	return contextStep("trusted pages", `thread ${threadId}`, async () => {
		const { runStep } = await import("../runtime/step.ts");
		const Threads = await import("../threads/Threads.ts");
		const { trustedPageKeys } = await import("../search/trusted-pages.ts");
		return trustedPageKeys(await runStep(Threads.Threads.use((threads) => threads.load(threadId))));
	});
}
trustedPagesStep.maxRetries = CONTEXT_STEP_RETRIES;

export async function webFetchStep(input: WebFetchInput) {
	"use step";
	const { runStep } = await import("../runtime/step.ts");
	const { executeWebFetch } = await import("../search/tool.ts");
	return runStep(executeWebFetch(input));
}

export async function saveReplyStep(
	threadId: string,
	owner: string,
	runId: string,
	model: string,
	failed = false,
	continued: Continued | null = null,
) {
	"use step";
	const { runStep } = await import("../runtime/step.ts");
	const { saveRunReply } = await import("./reply.ts");
	await runStep(saveRunReply(threadId, owner, runId, model, { failed, continued }));
}

/** Marks the run finished, and failed, when saving its reply failed, so the thread does not look busy forever. */
export async function finishRunStep(threadId: string, runId: string, model: string, continued: Continued | null = null) {
	"use step";
	const { runStep } = await import("../runtime/step.ts");
	const { finishFailedRun } = await import("./reply.ts");
	await runStep(finishFailedRun(threadId, runId, model, continued));
}

/**
 * Ends the reply's stream. The reply loop leaves it open (loop.ts), so that a run whose model
 * kept erroring can say so first: the page then shows the error and Retry, instead of
 * an empty reply.
 */
export async function endReplyStream(writable: WritableStream<ModelCallStreamPart>, error?: string) {
	"use step";
	const writer = writable.getWriter();
	try {
		if (error) await writer.write({ type: "error", error });
	} finally {
		writer.releaseLock();
	}
	await writable.close();
}
