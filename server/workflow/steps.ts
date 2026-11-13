import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { CompactRequest, CompactResult } from "../compaction/compact.ts";
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
 */
export async function loadModelMessages(
	threadId: string,
	owner: string,
	modelId: string,
	recalled: string,
	skills: ActiveSkill[] = [],
	/** The <connectors> note (mcp/catalog-note.ts). */
	connectors = "",
): Promise<ThreadContext> {
	"use step";
	const { loadThreadContext } = await import("./thread-messages.ts");
	return loadThreadContext(threadId, { owner, modelId, recalled, skills, connectors });
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
	const { compact } = await import("../compaction/compact.ts");
	const { attempt } = getStepMetadata();
	return compact(request, {
		lastAttempt: attempt > COMPACT_RETRIES,
		status: async (state) => {
			const writer = writable.getWriter();
			try {
				await writer.write({ type: "raw", rawValue: { [COMPACTION_MARKER]: state } });
				// Each model call starts with reset-step, which drops the parts of the step it is in.
				// So the status ends a step of its own, as the agent does between its steps.
				if (state.state !== "running") for (const type of ["finish-step", "start-step"]) await writer.write({ type } as unknown as ModelCallStreamPart);
			} finally {
				writer.releaseLock();
			}
		},
	});
}
compactStep.maxRetries = COMPACT_RETRIES;

/** Memory's guidance for the instructions, and what it recalls for the person's latest message. */
export async function recallMemoryStep(threadId: string, owner: string): Promise<{ guidance: string; recalled: string }> {
	"use step";
	return contextStep("memory", `thread ${threadId}`, async () => {
		const { loadThread } = await import("../db.ts");
		const { memoryForRun } = await import("../memory.ts");
		return memoryForRun({ threadId, user: owner }, await loadThread(threadId));
	});
}
recallMemoryStep.maxRetries = CONTEXT_STEP_RETRIES;

export async function runPythonStep(input: RunPythonInput, threadId: string, owner: string) {
	"use step";
	const { executeRunPython } = await import("../python/tool.ts");
	return executeRunPython(input, { threadId, owner });
}

export async function webSearchStep(input: WebSearchInput, threadId: string, owner: string) {
	"use step";
	const { executeWebSearch } = await import("../search/tool.ts");
	return executeWebSearch(input, { threadId, owner });
}

/** The pages web_fetch may read in this thread without asking the person (search/trusted-pages.ts). */
export async function trustedPagesStep(threadId: string): Promise<string[]> {
	"use step";
	return contextStep("trusted pages", `thread ${threadId}`, async () => {
		const { loadThread } = await import("../db.ts");
		const { trustedPageKeys } = await import("../search/trusted-pages.ts");
		return trustedPageKeys(await loadThread(threadId));
	});
}
trustedPagesStep.maxRetries = CONTEXT_STEP_RETRIES;

export async function webFetchStep(input: WebFetchInput) {
	"use step";
	const { executeWebFetch } = await import("../search/tool.ts");
	return executeWebFetch(input);
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
	const { saveReply } = await import("./reply.ts");
	await saveReply(threadId, owner, runId, model, { failed, continued });
}

/** Marks the run finished, and failed, when saving its reply failed, so the thread does not look busy forever. */
export async function finishRunStep(threadId: string, runId: string, model: string, continued: Continued | null = null) {
	"use step";
	const { finishRun } = await import("./runs.ts");
	await finishRun(threadId, runId, model, { failed: true, continued });
}

/**
 * Ends the reply's stream. The agent leaves it open (chat.ts), so that a run whose model
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

export type StepUsage = {
	threadId: string;
	user: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
	costUsd: number | null;
	finishReason: string;
	toolCalls: string[];
	/** The model asked for, and Ponder's estimate of the call's input tokens, to measure the thread's ratio. */
	requested: string;
	estimatedTokens: number;
};

/**
 * One `runs` row per model call: its tokens and OpenRouter's cost, which credits are
 * charged from. AI SDK telemetry records ToolLoopAgent runs; a WorkflowAgent's model
 * calls happen in steps, so the workflow records them with this step. On a replay the
 * step returns its recorded result, so a call is never counted twice. It also keeps the
 * thread's measured ratio of provider tokens to estimated ones (compaction/tokens.ts).
 */
export async function recordUsageStep(usage: StepUsage) {
	"use step";
	const { randomUUID } = await import("node:crypto");
	const { insertRun } = await import("../telemetry/store.ts");
	const { measuredRatio } = await import("../compaction/tokens.ts");
	const { saveTokenRatio } = await import("../compaction/store.ts");
	const ratio = measuredRatio(usage.inputTokens, usage.estimatedTokens);
	if (ratio) await saveTokenRatio(usage.threadId, usage.requested, ratio);
	await insertRun({
		id: randomUUID(),
		parentId: null,
		threadId: usage.threadId,
		user: usage.user,
		functionId: "chat",
		model: usage.model,
		steps: 1,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cachedTokens: usage.cachedTokens,
		costUsd: usage.costUsd,
		durationMs: 0,
		toolCalls: usage.toolCalls.map((name) => ({ name, status: "ok" as const })),
		finishReason: usage.finishReason,
	});
}
