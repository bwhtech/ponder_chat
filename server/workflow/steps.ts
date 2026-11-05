import type { ModelMessage } from "ai";
import type { RunPythonInput } from "../python/schema.ts";
import type { WebFetchInput, WebSearchInput } from "../search/schema.ts";

/**
 * The chat workflow's steps. Each is recorded in Postgres when it finishes; after a
 * restart the workflow replays and skips the steps that have a result. Steps load their
 * modules inside the step, because the workflow imports this file and workflow code
 * cannot load Node modules (the database, files, the sandbox).
 */

/**
 * The thread as the model reads it: the owner's attached files swapped for their content
 * (file-context.ts), tool results of earlier turns trimmed, and what memory recalled added to
 * the person's latest message (context.ts).
 */
export async function loadModelMessages(threadId: string, owner: string, modelId: string, recalled: string): Promise<ModelMessage[]> {
	"use step";
	const { convertToModelMessages } = await import("ai");
	const { loadThread } = await import("../db.ts");
	const { resolveFileParts } = await import("../file-context.ts");
	const { MODELS } = await import("../models.ts");
	const { getSettings } = await import("../settings.ts");
	const { addRecalledMemory, trimOldToolResults } = await import("./context.ts");
	const readsPdf = MODELS.find((model) => model.id === modelId)?.readsPdf ?? false;
	const pdfAsText = !readsPdf && (await getSettings()).pdfTextOnServer;
	const messages = await convertToModelMessages(await resolveFileParts(await loadThread(threadId), owner, { pdfAsText }));
	return addRecalledMemory(trimOldToolResults(messages), recalled);
}

/** Memory's guidance for the instructions, and what it recalls for the person's latest message. */
export async function recallMemoryStep(threadId: string, owner: string): Promise<{ guidance: string; recalled: string }> {
	"use step";
	const { loadThread } = await import("../db.ts");
	const { memoryForRun } = await import("../memory.ts");
	return memoryForRun({ threadId, user: owner }, await loadThread(threadId));
}

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
	continued: { messageId: string; baseParts: number } | null = null,
) {
	"use step";
	const { saveReply } = await import("./reply.ts");
	await saveReply(threadId, owner, runId, model, { untilTail: failed, continued });
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
