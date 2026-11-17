import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as CompactionStore from "../compaction/store.ts";
import { withSummary } from "../compaction/summary.ts";
import { estimate, type Estimate } from "../compaction/tokens.ts";
import { resolveFileParts } from "../file-context.ts";
import * as AutoRouter from "../models/AutoRouter.ts";
import { MODELS } from "../models/Models.ts";
import * as Settings from "../settings/Settings.ts";
import type { ActiveSkill } from "../skills.ts";
import * as Threads from "../threads/Threads.ts";
import { openAnswersSettled } from "./answered-again.ts";
import { citationPartText } from "./citations.ts";
import { addConnectorNote, connectorCallsInHistory } from "./connector-messages.ts";
import { addRecalledMemory, addWorkspaceExcerpts, dropOtherModelsReasoning, trimOldToolResults } from "./context.ts";
import { skillPartText } from "./skills.ts";

/** Who and what a reply's messages are for. */
export type MessageOptions = {
	owner: string;
	modelId: string;
	recalled: string;
	skills: ActiveSkill[];
	/** The <connectors> note (mcp/catalog-note.ts). Like `recalled`, it goes with the latest message and is never summarized. */
	connectors: string;
	/** The <workspace_excerpts> block (workspaces/prompt.ts). Like `recalled`, it goes with the latest message and is never summarized. */
	excerpts?: string;
	/** A reply that keeps its reasoning (context.ts, dropOtherModelsReasoning). */
	keepReasoningOf?: string;
};

/** The messages of a reply's first model call, with what compaction decides from. */
export type ThreadContext = {
	messages: ModelMessage[];
	/** Their estimated tokens (compaction/tokens.ts). */
	estimate: Estimate;
	/** Provider tokens per estimated token, measured on this thread's last call of this model. */
	ratio: number;
	/** The model's context window, or null when OpenRouter's list does not give it. */
	window: number | null;
	/** The last message the saved summary covers, when the messages read one. */
	through?: string;
};

/**
 * The thread as the model reads it, with its saved summary in place of the messages it covers.
 * Untraced, as these were before: thread.load and file_context.resolve stay the step's children.
 */
export const loadThreadContext = Effect.fnUntraced(function* (threadId: string, options: MessageOptions) {
	const store = yield* CompactionStore.CompactionStore;
	const thread = yield* Threads.Threads.use((threads) => threads.load(threadId));
	const summary = Option.getOrUndefined(yield* store.loadSummary(threadId, thread));
	const messages = yield* modelMessages(withSummary(thread, summary), options);
	return {
		messages,
		estimate: estimate(messages),
		ratio: yield* store.tokenRatio(threadId, options.modelId),
		window: Option.getOrNull(yield* AutoRouter.AutoRouter.use((router) => router.modelWindow(options.modelId))),
		...(summary && { through: thread[summary.covers - 1]?.id }),
	} satisfies ThreadContext;
});

/**
 * Messages as the model reads them: the owner's attached files swapped for their content
 * (file-context.ts), the skills they chose with $name swapped for their instructions (skills.ts),
 * the reply text they cited marked as a quote (citations.ts), the reasoning of replies
 * another model wrote left out, tool results of earlier turns trimmed, and what memory
 * recalled, the workspace's excerpts and the person's connectors added to the person's
 * latest message (context.ts, connector-messages.ts).
 */
export const modelMessages = Effect.fnUntraced(function* (thread: UIMessage[], { owner, modelId, recalled, skills, connectors, excerpts = "", keepReasoningOf }: MessageOptions) {
	const readsPdf = MODELS.find((model) => model.id === modelId)?.readsPdf ?? false;
	const pdfAsText = !readsPdf && (yield* Settings.Settings.use((settings) => settings.get)).pdfTextOnServer;
	const resolved = yield* resolveFileParts(dropOtherModelsReasoning(openAnswersSettled(thread), modelId, keepReasoningOf), owner, { pdfAsText });
	// The SDK's conversion fails only on messages it can't read: a bug, thrown as itself.
	const messages: ModelMessage[] = yield* Effect.promise(() =>
		convertToModelMessages(resolved, {
			convertDataPart: (part) => skillPartText(part, skills) ?? citationPartText(part),
		}),
	);
	return addConnectorNote(addWorkspaceExcerpts(addRecalledMemory(trimOldToolResults(connectorCallsInHistory(messages)), recalled), excerpts), connectors);
});
