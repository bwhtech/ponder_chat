import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { loadSummary, tokenRatio } from "../compaction/store.ts";
import { withSummary } from "../compaction/summary.ts";
import { estimateTokens } from "../compaction/tokens.ts";
import { loadThread } from "../db.ts";
import { resolveFileParts } from "../file-context.ts";
import { MODELS } from "../models.ts";
import { contextWindow } from "../openrouter.ts";
import { getSettings } from "../settings.ts";
import type { ActiveSkill } from "../skills.ts";
import { citationPartText } from "./citations.ts";
import { addConnectorNote, connectorCallsInHistory } from "./connector-messages.ts";
import { addRecalledMemory, dropOtherModelsReasoning, trimOldToolResults } from "./context.ts";
import { skillPartText } from "./skills.ts";

/** Who and what a reply's messages are for. */
export type MessageOptions = {
	owner: string;
	modelId: string;
	recalled: string;
	skills: ActiveSkill[];
	/** The <connectors> note (mcp/catalog-note.ts). Like `recalled`, it goes with the latest message and is never summarized. */
	connectors: string;
};

/** The messages of a reply's first model call, with what compaction decides from. */
export type ThreadContext = {
	messages: ModelMessage[];
	/** Their estimated tokens (compaction/tokens.ts). */
	tokens: number;
	/** Provider tokens per estimated token, measured on this thread's last call of this model. */
	ratio: number;
	/** The model's context window, or null when OpenRouter's list does not give it. */
	window: number | null;
};

/** The thread as the model reads it, with its saved summary in place of the messages it covers. */
export async function loadThreadContext(threadId: string, options: MessageOptions): Promise<ThreadContext> {
	const thread = await loadThread(threadId);
	const messages = await modelMessages(withSummary(thread, await loadSummary(threadId, thread)), options);
	return {
		messages,
		tokens: estimateTokens(messages),
		ratio: await tokenRatio(threadId, options.modelId),
		window: (await contextWindow(options.modelId)) ?? null,
	};
}

/**
 * Messages as the model reads them: the owner's attached files swapped for their content
 * (file-context.ts), the skills they chose with $name swapped for their instructions (skills.ts),
 * the reply text they cited marked as a quote (citations.ts), the reasoning of replies
 * another model wrote left out, tool results of earlier turns trimmed, and what memory
 * recalled and the person's connectors added to the person's latest message (context.ts,
 * connector-messages.ts).
 */
export async function modelMessages(thread: UIMessage[], { owner, modelId, recalled, skills, connectors }: MessageOptions): Promise<ModelMessage[]> {
	const readsPdf = MODELS.find((model) => model.id === modelId)?.readsPdf ?? false;
	const pdfAsText = !readsPdf && (await getSettings()).pdfTextOnServer;
	const resolved = await resolveFileParts(dropOtherModelsReasoning(thread, modelId), owner, { pdfAsText });
	const messages = await convertToModelMessages(resolved, {
		convertDataPart: (part) => skillPartText(part, skills) ?? citationPartText(part),
	});
	return addConnectorNote(addRecalledMemory(trimOldToolResults(connectorCallsInHistory(messages)), recalled), connectors);
}

