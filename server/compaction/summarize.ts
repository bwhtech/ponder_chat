import { generateText, type UIMessage } from "ai";
import { availableModels } from "../models.ts";
import { contextWindow, privateRouting } from "../openrouter.ts";
import { openRouter } from "../openrouter-key.ts";
import { getSettings } from "../settings.ts";
import { COMPACTION_FUNCTION_ID, runTelemetry, type RunContext } from "../telemetry.ts";
import { SUMMARY_INSTRUCTIONS, summaryPrompt } from "./prompt.ts";
import { budgetFor, estimateTokens } from "./tokens.ts";
import { clipMiddle, renderTranscript } from "./transcript.ts";

/**
 * Writes a chat's summary with the model admins chose (settings.ts), through a private
 * (ZDR) endpoint like every other call. The call goes to `runs` as "compaction", and is
 * charged to the person's credits, as memory and web search are.
 *
 * The chat's own model writes it instead when the chosen one is not available, or its
 * window is too small for the transcript.
 */
const MAX_OUTPUT_TOKENS = 16_000;
/** A summary longer than this is cut in the middle, never summarized again: a smaller tail does not make it smaller. */
const MAX_SUMMARY_CHARS = 48_000;

export type SummaryInput = {
	run: RunContext;
	chatModel: string;
	/** The summary these messages come after, if any. */
	previous: string | undefined;
	messages: UIMessage[];
};

export async function writeSummary({ run, chatModel, previous, messages }: SummaryInput): Promise<{ text: string; model: string }> {
	const full = renderTranscript(messages, Number.POSITIVE_INFINITY);
	const needed = estimateTokens(summaryPrompt(previous, full)) + estimateTokens(SUMMARY_INSTRUCTIONS) + MAX_OUTPUT_TOKENS;
	const model = await summaryModel(chatModel, needed);
	const limit = await roomFor(model);
	// Over the room, the oldest messages are cut first. The previous summary never is.
	const room = limit - MAX_OUTPUT_TOKENS - estimateTokens(SUMMARY_INSTRUCTIONS) - estimateTokens(summaryPrompt(previous, ""));
	const transcript = needed <= limit ? full : renderTranscript(messages, room);
	const { text } = await generateText({
		model: (await openRouter())(model, { usage: { include: true }, provider: privateRouting }),
		instructions: SUMMARY_INSTRUCTIONS,
		prompt: summaryPrompt(previous, transcript),
		maxOutputTokens: MAX_OUTPUT_TOKENS,
		...runTelemetry(run, COMPACTION_FUNCTION_ID),
	});
	if (!text.trim()) throw new Error(`${model} wrote an empty summary`);
	return { text: clipMiddle(text.trim(), MAX_SUMMARY_CHARS), model };
}

/** The chosen model when it is available and has room for `needed` tokens; else the chat's model. */
async function summaryModel(chatModel: string, needed: number) {
	const chosen = (await getSettings()).compactionModel;
	if (chosen === chatModel) return chatModel;
	const { models } = await availableModels();
	if (!models.some((model) => model.id === chosen)) return chatModel;
	return (await roomFor(chosen)) >= needed ? chosen : chatModel;
}

/** The tokens one call to `model` may take: 90% of its window. */
async function roomFor(model: string) {
	return budgetFor(await contextWindow(model)).limit;
}
