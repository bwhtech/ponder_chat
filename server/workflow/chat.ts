import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { isStepCount, tool } from "ai";
import { getWorkflowMetadata, getWritable } from "workflow";
import { RUN_PYTHON, RUN_PYTHON_DESCRIPTION, runPythonInput } from "../python/schema.ts";
import { ChatModel } from "./model.ts";
import { loadModelMessages, recallMemoryStep, recordUsageStep, runPythonStep, saveReplyStep } from "./steps.ts";

export type ChatTurn = {
	threadId: string;
	owner: string;
	model: { id: string; name: string };
	python: boolean;
	/** Set by the route, so the prompt does not read the clock inside the workflow. */
	today: string;
	maxSteps: number;
};

/**
 * One reply, as a durable workflow run. Each model call and each tool call is a step
 * recorded in Postgres. If the server stops in the middle, the run replays from that
 * record when it starts again and goes on from the first step without a result, and
 * the page that follows it sees the rest of the reply.
 *
 * The thread is saved by the run's last step, so the reply is kept even when nobody is
 * watching. The route saved the person's message before it started the run.
 */
export async function chatTurn(turn: ChatTurn) {
	"use workflow";

	// What the person told Ponder in earlier chats (server/memory.ts). The turn is saved to memory with the reply (reply.ts).
	const memory = await recallMemoryStep(turn.threadId, turn.owner);
	const agent = new WorkflowAgent({
		model: new ChatModel(turn.model.id),
		instructions: [instructions(turn), memory].filter(Boolean).join("\n\n"),
		tools: turn.python
			? {
					[RUN_PYTHON]: tool({
						description: RUN_PYTHON_DESCRIPTION,
						inputSchema: runPythonInput,
						execute: (input) => runPythonStep(input, turn.threadId, turn.owner),
					}),
				}
			: {},
		// Credits are charged from what each model call cost (steps.ts).
		onStepEnd: async (step) => {
			const metadata = step.providerMetadata?.openrouter as { usage?: { cost?: number } } | undefined;
			const raw = step.usage.raw as { cost?: number } | undefined;
			await recordUsageStep({
				threadId: turn.threadId,
				user: turn.owner,
				model: step.response?.modelId ?? turn.model.id,
				inputTokens: step.usage.inputTokens ?? 0,
				outputTokens: step.usage.outputTokens ?? 0,
				cachedTokens: step.usage.inputTokenDetails?.cacheReadTokens ?? 0,
				costUsd: metadata?.usage?.cost ?? raw?.cost ?? null,
				finishReason: step.finishReason,
				toolCalls: step.toolCalls.map((call) => call.toolName),
			});
		},
	});

	// The reply is saved and the run marked finished even when the run fails (a model
	// that keeps erroring), so the thread never looks busy forever. A failed run does not
	// close its stream, so then only what it wrote is saved.
	const { workflowRunId } = getWorkflowMetadata();
	let failure: unknown;
	try {
		await agent.stream({
			messages: await loadModelMessages(turn.threadId),
			writable: getWritable<ModelCallStreamPart>(),
			stopWhen: isStepCount(turn.maxSteps),
		});
	} catch (error) {
		failure = error;
	}
	await saveReplyStep(turn.threadId, turn.owner, workflowRunId, turn.model.id, Boolean(failure));
	if (failure) throw failure;
}

function instructions({ model, today, python }: ChatTurn) {
	return `You are Ponder, a helpful assistant. You run on ${model.name}. Today is ${today}.

Answer clearly and directly. Use Markdown when it helps: lists, tables, and code blocks with a language. Keep answers as short as the question allows. If you are not sure, say so.${
		python
			? `

You can run Python with run_python. Use it for data the person attached, statistics, charts and files to download, and for any calculation where a mistake would matter. Do not paste the code or a file's contents again in your reply: the person sees the run and its files. Say what you found.`
			: ""
	}`;
}
