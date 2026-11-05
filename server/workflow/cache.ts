import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { turnsStart, WHOLE_TURNS } from "./context.ts";

/**
 * Prompt caching for the models that need it asked for. OpenAI, Gemini, DeepSeek and
 * others cache the start of a prompt by themselves. Anthropic's models cache only up to
 * the points a request marks (at most four), so OpenRouter passes `cache_control` on.
 * A cached read costs a tenth of the price, and credits follow OpenRouter's cost.
 *
 * Four points, the most Anthropic takes, each on the last message of the person or of
 * a tool at that place. Not on a reply: OpenRouter sends a reply's text as a plain
 * string, which has no block to carry the mark.
 * - The instructions.
 * - The end of the history before the turns kept whole (context.ts). It never changes
 *   again, so the next call reads it.
 * - The end of the history before the latest turn. The next call reads it too, unless
 *   the turn before the latest had long tool output, which gets trimmed then.
 * - The last message, so each tool step of this turn reads what the step before wrote.
 *
 * The latest turn is always sent uncached: its memory note is dropped on the next call.
 */
const EPHEMERAL = { openrouter: { cacheControl: { type: "ephemeral" } } };

export function needsCacheMarks(modelId: string) {
	return modelId.startsWith("anthropic/");
}

export function withCacheMarks(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
	const roles = prompt.map((message) => message.role);
	const marks = new Set([
		roles.indexOf("system"),
		historyEnd(roles, turnsStart(roles, WHOLE_TURNS)),
		historyEnd(roles, turnsStart(roles, 1)),
		prompt.length - 1,
	]);
	return prompt.map((message, index) => (marks.has(index) ? mark(message) : message));
}

/** The last message of the person or of a tool before `index`; -1 when there is none. */
function historyEnd(roles: string[], index: number) {
	// lastIndexOf with a negative start would search from the end.
	return index > 0 ? Math.max(roles.lastIndexOf("user", index - 1), roles.lastIndexOf("tool", index - 1)) : -1;
}

/** Marks the message's last block. A tool message holds one result per call, and each would count as a mark. */
function mark(message: LanguageModelV4Prompt[number]): LanguageModelV4Prompt[number] {
	if (message.role !== "tool") return { ...message, providerOptions: { ...message.providerOptions, ...EPHEMERAL } };
	const last = message.content.length - 1;
	return { ...message, content: message.content.map((part, index) => (index === last ? { ...part, providerOptions: { ...part.providerOptions, ...EPHEMERAL } } : part)) };
}
