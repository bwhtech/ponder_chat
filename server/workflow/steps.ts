import type { ModelMessage } from "ai";
import type { RunPythonInput } from "../python/schema.ts";

/**
 * The chat workflow's steps. Each is recorded in Postgres when it finishes; after a
 * restart the workflow replays and skips the steps that have a result. Steps load their
 * modules inside the step, because the workflow imports this file and workflow code
 * cannot load Node modules (the database, files, the sandbox).
 */

/** The thread as the model reads it, with attached files swapped for their content. */
export async function loadModelMessages(threadId: string): Promise<ModelMessage[]> {
	"use step";
	const { convertToModelMessages } = await import("ai");
	const { loadThread } = await import("../db.ts");
	const { resolveFileParts } = await import("../files.ts");
	return convertToModelMessages(await resolveFileParts(await loadThread(threadId)));
}

/** What memory adds to the instructions: how it works, and what it recalls for the person's latest message. */
export async function recallMemoryStep(threadId: string, owner: string): Promise<string> {
	"use step";
	const { loadThread } = await import("../db.ts");
	const { memoryInstructions } = await import("../memory.ts");
	return memoryInstructions({ threadId, user: owner }, await loadThread(threadId));
}

export async function runPythonStep(input: RunPythonInput, threadId: string, owner: string) {
	"use step";
	const { executeRunPython } = await import("../python/tool.ts");
	return executeRunPython(input, { threadId, owner });
}

export async function saveReplyStep(threadId: string, owner: string, runId: string, model: string, failed = false) {
	"use step";
	const { saveReply } = await import("./reply.ts");
	await saveReply(threadId, owner, runId, model, { untilTail: failed });
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
