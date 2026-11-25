import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { getWorkflowMetadata, getWritable } from "workflow";
import { RESEARCH_MODEL, type WebMode } from "../../shared/web-mode.ts";
import { ContextGuard, ContextOverLimitError } from "./context-guard.ts";
import { runReply } from "./loop.ts";
import type { Continued } from "./runs.ts";
import { endReplyStream, finishRunStep, saveReplyStep, turnContextStep } from "./steps.ts";

export type ChatTurn = {
	threadId: string;
	owner: string;
	model: { id: string; name: string };
	python: boolean;
	/** Set by the route, so the prompt does not read the clock inside the workflow. */
	today: string;
	maxSteps: number;
	/** The assistant message this run carries on, after the person answered an approval (runs.ts). */
	continued: Continued | null;
	/**
	 * Under Auto, for a run that carries on a reply: the model that answered the reply's
	 * last call (replies.ts). The run goes to it, and the reply keeps its reasoning.
	 */
	answeredBy?: string;
	/** The chat's workspace, checked by the route (replies.ts). Its instructions go into the system prompt. */
	workspaceId?: string;
	/** What the reply may reach on the web: the choice of the person's latest message (shared/web-mode.ts). */
	web: WebMode;
};

/**
 * One reply, as a durable workflow run (loop.ts). Each model call and each tool call is
 * a step recorded in Postgres. If the server stops in the middle, the run replays from
 * that record when it starts again and goes on from the first step without a result,
 * and the page that follows it sees the rest of the reply. A model call cut short starts
 * again, and the page drops what it had written (model-call.ts).
 *
 * The thread is saved by the run's last step, so the reply is kept even when nobody is
 * watching. The route saved the person's message before it started the run.
 */
export async function chatTurn(turn: ChatTurn) {
	"use workflow";

	// The reply is saved and the run marked finished on every way out: a model that keeps
	// erroring, memory or connectors that fail, or a save that fails. So the thread never
	// looks busy forever. A failed run ends its stream with an error, so the page shows
	// it with Retry, and is marked failed, so a page that loads the thread later does too.
	const { workflowRunId } = getWorkflowMetadata();
	const writable = getWritable<ModelCallStreamPart>();
	let failure: unknown;
	try {
		// What the reply reads before its first model call, in one step (steps.ts): what the person
		// told Ponder in earlier chats (server/memory.ts; the turn is saved to memory with the reply,
		// reply.ts), the tools of the apps they connected (server/mcp/), the skills admins turned
		// on (server/skills.ts), the pages web_fetch may read without asking, the workspace's
		// instructions, documents and excerpts (server/workspaces/), the thread as the model reads
		// it, and the reply's system prompt and tools (reply-tools.ts). Without any but the
		// thread, the reply is still written.
		// Deep research is Perplexity's model (RESEARCH_MODEL): it searches and reads the web for minutes on its
		// own, and takes no tools. The workspace reaches it as text: its documents, and the excerpts for the message.
		const research = turn.web === "research";
		const model = research ? RESEARCH_MODEL : turn.model;
		// A long chat is summarized before a call would go over the model's window (context-guard.ts).
		const keep = turn.answeredBy ? turn.continued?.messageId : undefined;
		const { memory, skills, workspace, context, system, connectors, toolsTurn, tools } = await turnContextStep(writable, turn, { modelId: model.id, keepReasoningOf: keep });
		// The <connectors> note and the workspace's best passages for this message go with it, as memory's do.
		const excerpts = workspace?.excerpts ?? "";
		const base = { threadId: turn.threadId, owner: turn.owner, runId: workflowRunId, modelId: model.id, recalled: memory.recalled, skills, connectors, excerpts, keepReasoningOf: keep };
		const guard = new ContextGuard(base, context, tools.tokens, writable, model.name);
		// Each model call records its cost in `runs`, which credits are charged from (model-attempt.ts).
		await runReply({
			call: { runId: workflowRunId, threadId: turn.threadId, owner: turn.owner, modelId: research ? model.id : (turn.answeredBy ?? model.id), instructions: system, ...(research && { research }) },
			messages: await guard.initialMessages(system),
			tools: { ...tools, turn: toolsTurn },
			// Keeps each model call inside the model's window, between the reply's steps too.
			guard,
			writable,
			// One call: the research model has no tools to call back for.
			maxSteps: research ? 1 : turn.maxSteps,
		});
	} catch (error) {
		failure = error;
	}
	const failed = turn.web === "research" ? "Deep research could not finish. Retry, or ask without it." : `${turn.model.name} could not finish this reply. Retry, or choose another model.`;
	const message = failure instanceof ContextOverLimitError ? failure.message : failure ? failed : undefined;
	// A stream left open would keep the save below waiting, so then the save reads only what the run wrote.
	const ended = await endReplyStream(writable, message).then(
		() => true,
		() => false,
	);
	try {
		await saveReplyStep(turn.threadId, turn.owner, workflowRunId, turn.model.id, Boolean(failure) || !ended, turn.continued);
	} catch (error) {
		await finishRunStep(turn.threadId, workflowRunId, turn.model.id, turn.continued);
		throw failure ?? error;
	}
	if (failure) throw failure;
}
