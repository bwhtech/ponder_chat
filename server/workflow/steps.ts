import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { CompactionState, CompactRequest, CompactResult } from "../compaction/compaction.ts";
import type { RunPythonInput } from "../python/schema.ts";
import type { WebFetchInput, WebSearchInput } from "../search/schema.ts";
import type { ActiveSkill } from "../skills.ts";
import type { ModelMessage, UIMessage } from "ai";
import type { CatalogData } from "../mcp/catalog.ts";
import type { ChatTurn } from "./chat.ts";
import { gatherContext } from "./context-step.ts";
import type { ModelToolCall } from "./model-call.ts";
import type { ToolSetup, ToolsTurn } from "./reply-tools.ts";
import type { PlannedCall } from "./tool-outcomes.ts";
import { COMPACTION_MARKER } from "./stream-parts.ts";
import type { Continued } from "./runs.ts";
import type { ThreadContext } from "./thread-messages.ts";
import type { WorkspaceSearchInput, WorkspaceTurn } from "../workspaces/prompt.ts";

/**
 * The chat workflow's steps. Each is recorded in Postgres when it finishes; after a
 * restart the workflow replays and skips the steps that have a result. Steps load their
 * modules inside the step, because the workflow imports this file and workflow code
 * cannot load Node modules (the database, files, the sandbox).
 */

/** Everything a reply reads before its first model call (turnContextStep). */
export type TurnContext = {
	/** Memory's guidance for the instructions, and what it recalls for the person's latest message. */
	memory: { guidance: string; recalled: string };
	/** The tools of the apps the person connected (server/mcp/), as plain data. */
	catalog: CatalogData;
	/** The skills admins turned on (server/skills.ts). */
	skills: ActiveSkill[];
	/** The pages web_fetch may read in this thread without asking the person (search/trusted-pages.ts). */
	trustedPages: string[];
	/** The workspace's part of the turn; null without a workspace, or when it could not be read. */
	workspace: WorkspaceTurn | null;
	/** The thread as the model reads it (thread-messages.ts). */
	context: ThreadContext;
	/** The reply's system prompt (reply-tools.ts). */
	system: string;
	/** The <connectors> note, which goes with the latest message (mcp/catalog-note.ts). */
	connectors: string;
	/** What decides the reply's tools, for the steps that check and run its calls (planToolCallsStep). */
	toolsTurn: ToolsTurn;
	/** The tools as the workflow keeps them: plain data (reply-tools.ts). */
	tools: ToolSetup;
};

/**
 * What a reply reads before its first model call, in one step: memory, connectors, skills,
 * trusted pages and the workspace at once, then the thread as the model reads it, which
 * needs them.
 *
 * One step, not six: the workflow resumes after each step, and each resume evaluates its
 * whole bundle again, so six steps in a row held up the first word of every reply. It
 * also makes the reply's system prompt and tools (reply-tools.ts), which the workflow
 * code must not load. Each read but the thread's has its own retries and
 * falls back to a reply without it (gatherContext). The thread is read once for memory
 * and trusted pages. A failure to read it fails the step, which Workflow runs again.
 *
 * The thread has its saved summary in place of the messages it covers, and what compaction
 * decides from: the estimate, the thread's measured ratio and the model's window. A reply
 * that reads a saved summary says so to the page, as the reply that wrote it did, so the
 * divider stays after a Retry of that reply.
 */
export async function turnContextStep(
	writable: WritableStream<ModelCallStreamPart>,
	turn: ChatTurn,
	options: {
		/** The model the reply's messages are for (the research model under deep research). */
		modelId: string;
		/** A reply that keeps its reasoning (context.ts). */
		keepReasoningOf?: string;
	},
): Promise<TurnContext> {
	"use step";
	const { threadId, owner, workspaceId } = turn;
	const { EMPTY_CATALOG } = await import("../mcp/catalog.ts");
	const { connectorNote } = await import("../mcp/catalog-note.ts");
	const ReplyTools = await import("./reply-tools.ts");
	const { runStep } = await import("../runtime/step.ts");
	const Threads = await import("../threads/Threads.ts");
	let thread: Promise<UIMessage[]> | undefined;
	const messages = () => (thread ??= runStep(Threads.Threads.use((threads) => threads.load(threadId))));
	const [memory, catalog, skills, trustedPages, workspace] = await Promise.all([
		gatherContext("memory", `thread ${threadId}`, { guidance: "", recalled: "" }, async () => {
			const Memory = await import("../memory.ts");
			const loaded = await messages();
			return runStep(Memory.Memory.use((memory) => memory.forRun({ threadId, user: owner }, loaded)));
		}),
		gatherContext("connectors", `person ${owner}`, EMPTY_CATALOG, async () => {
			const Connectors = await import("../mcp/Connectors.ts");
			return runStep(Connectors.Connectors.use((connectors) => connectors.connectorCatalogFor(owner)));
		}),
		gatherContext("skills", "all skills", [] as ActiveSkill[], async () => {
			const Skills = await import("../skills.ts");
			return runStep(Skills.Skills.use((skills) => skills.active));
		}),
		gatherContext("trusted pages", `thread ${threadId}`, [] as string[], async () => {
			const { trustedPageKeys } = await import("../search/trusted-pages.ts");
			return trustedPageKeys(await messages());
		}),
		// Null when they can no longer ask in it: the route checked before the run started, so that is a race.
		workspaceId
			? gatherContext("workspace", `workspace ${workspaceId}`, null, async () => {
					const Option = await import("effect/Option");
					const { workspaceTurn } = await import("../workspaces/documents/turn.ts");
					return Option.getOrNull(await runStep(workspaceTurn({ owner, workspaceId, threadId, modelId: turn.model.id })));
				})
			: null,
	]);
	const connectors = connectorNote(catalog);
	const { loadThreadContext } = await import("./thread-messages.ts");
	const context = await runStep(
		loadThreadContext(threadId, {
			owner,
			modelId: options.modelId,
			recalled: memory.recalled,
			skills,
			connectors,
			excerpts: workspace?.excerpts ?? "",
			keepReasoningOf: options.keepReasoningOf,
		}),
	);
	if (context.through) await writeCompactionState(writable, { state: "done", through: context.through });
	const sourcesOnly = Boolean(workspace) && turn.web === "off";
	const toolsTurn: ToolsTurn = {
		threadId,
		owner,
		python: turn.python,
		web: turn.web,
		...(workspaceId && { workspaceId }),
		catalog,
		skills,
		trustedPages,
		searchDocumentIds: workspace?.searchDocumentIds ?? [],
		sourcesOnly,
	};
	const system = ReplyTools.systemPrompt(turn, { guidance: memory.guidance, workspace, sourcesOnly, skills, catalog });
	return { memory, catalog, skills, trustedPages, workspace, context, system, connectors, toolsTurn, tools: await ReplyTools.toolSetup(toolsTurn) };
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

/** workspace_search, bound by the workflow to the chat's workspace and the documents in search: the model gives only the query. */
export async function workspaceSearchStep(input: WorkspaceSearchInput, scope: { owner: string; workspaceId: string; threadId: string; documentIds: string[] }): Promise<string> {
	"use step";
	const { runStep } = await import("../runtime/step.ts");
	const { searchWorkspace } = await import("../workspaces/documents/turn.ts");
	const { searchResult } = await import("../workspaces/prompt.ts");
	return searchResult(await runStep(searchWorkspace({ ...scope, query: input.query })));
}

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

/**
 * Checks a model response's tool calls, and decides for each: ask the person first, run
 * its own step, or its outcome (reply-tools.ts, ToolCalls.plan). Tools with no step of
 * their own (write_artifact, show_ui, use_skill, connector_search…) run here: they are pure,
 * so a run that replays gets the same. An `approved` call is one the person approved.
 */
export async function planToolCallsStep(turn: ToolsTurn, calls: ModelToolCall[], messages: ModelMessage[], approved = false): Promise<PlannedCall[]> {
	"use step";
	const { planToolCalls } = await import("./reply-tools.ts");
	return planToolCalls(turn, calls, messages, approved);
}

/**
 * One connector tool call. It returns a failure as its result instead of throwing, and
 * it is never retried: a retried call could create the same issue or send the same
 * email twice. After a crash in the middle of the call, the workflow runtime fails the
 * step instead of running it again (a step with no retries runs once).
 */
export async function callConnectorToolStep(connectionId: string, toolName: string, input: unknown, owner: string, approved: boolean): Promise<string> {
	"use step";
	const { runStep } = await import("../runtime/step.ts");
	const Connectors = await import("../mcp/Connectors.ts");
	return runStep(Connectors.Connectors.use((connectors) => connectors.callConnectorTool(connectionId, toolName, input, owner, approved)));
}
callConnectorToolStep.maxRetries = 0;
