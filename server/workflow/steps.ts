import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { ModelMessage } from "ai";
import type { RunPythonInput } from "../python/schema.ts";
import type { WebFetchInput, WebSearchInput } from "../search/schema.ts";
import type { ActiveSkill } from "../skills.ts";
import { CONTEXT_STEP_RETRIES, contextStep } from "./context-step.ts";
import type { Continued } from "./runs.ts";

/**
 * The chat workflow's steps. Each is recorded in Postgres when it finishes; after a
 * restart the workflow replays and skips the steps that have a result. Steps load their
 * modules inside the step, because the workflow imports this file and workflow code
 * cannot load Node modules (the database, files, the sandbox).
 */

/**
 * The thread as the model reads it: the owner's attached files swapped for their content
 * (file-context.ts), the skills they chose with $name swapped for their instructions (skills.ts),
 * the reply text they cited marked as a quote (citations.ts), the reasoning of replies
 * another model wrote left out,
 * tool results of earlier turns trimmed, and what memory recalled and the person's
 * connectors added to the person's latest message (context.ts, connector-messages.ts).
 */
export async function loadModelMessages(
	threadId: string,
	owner: string,
	modelId: string,
	recalled: string,
	skills: ActiveSkill[] = [],
	/** The <connectors> note (mcp/catalog-note.ts). */
	connectors = "",
): Promise<ModelMessage[]> {
	"use step";
	const { convertToModelMessages } = await import("ai");
	const { loadThread } = await import("../db.ts");
	const { resolveFileParts } = await import("../file-context.ts");
	const { MODELS } = await import("../models.ts");
	const { getSettings } = await import("../settings.ts");
	const { addRecalledMemory, dropOtherModelsReasoning, trimOldToolResults } = await import("./context.ts");
	const { skillPartText } = await import("./skills.ts");
	const { citationPartText } = await import("./citations.ts");
	const { addConnectorNote, connectorCallsInHistory } = await import("./connector-messages.ts");
	const readsPdf = MODELS.find((model) => model.id === modelId)?.readsPdf ?? false;
	const pdfAsText = !readsPdf && (await getSettings()).pdfTextOnServer;
	const thread = dropOtherModelsReasoning(await loadThread(threadId), modelId);
	const messages = await convertToModelMessages(await resolveFileParts(thread, owner, { pdfAsText }), {
		convertDataPart: (part) => skillPartText(part, skills) ?? citationPartText(part),
	});
	return addConnectorNote(addRecalledMemory(trimOldToolResults(connectorCallsInHistory(messages)), recalled), connectors);
}

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
};

/**
 * One `runs` row per model call: its tokens and OpenRouter's cost, which credits are
 * charged from. AI SDK telemetry records ToolLoopAgent runs; a WorkflowAgent's model
 * calls happen in steps, so the workflow records them with this step. On a replay the
 * step returns its recorded result, so a call is never counted twice.
 */
export async function recordUsageStep(usage: StepUsage) {
	"use step";
	const { randomUUID } = await import("node:crypto");
	const { insertRun } = await import("../telemetry/store.ts");
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
