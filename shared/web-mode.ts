/**
 * What a reply may reach on the web. The person sets it under the message box
 * (web/web-tools.ts), and each of their messages carries it in its metadata, so it is saved
 * with the thread: a Retry, and a reply carried on after an approval, read the same choice.
 *
 * - off: no web_search and no web_fetch. In a workspace, the reply answers from its Sources only.
 * - search: web_search and web_fetch, as before.
 * - research: for one message. Each web_search is a deep search, and the reply is a report.
 */
export type WebMode = "off" | "search" | "research";

/** What the chat stays on. Deep research is never kept: it is for one message. */
export type KeptWebMode = Exclude<WebMode, "research">;

/**
 * A message's choice. `keep` is what the chat goes back to when the message's own mode is
 * for that message only: deep research, or one search from "Search the web for this".
 */
export type WebChoice = { web: WebMode; keep?: KeptWebMode };

function isWebMode(value: unknown): value is WebMode {
	return value === "off" || value === "search" || value === "research";
}

/** The choice in a message's metadata, or none: a message from before the choice existed. */
export function webChoiceOf(metadata: unknown): WebChoice | undefined {
	if (typeof metadata !== "object" || metadata === null || !("web" in metadata)) return undefined;
	const { web } = metadata;
	if (!isWebMode(web)) return undefined;
	const keep = "keep" in metadata && (metadata.keep === "off" || metadata.keep === "search") ? metadata.keep : undefined;
	return { web, ...(keep && { keep }) };
}

/** The choice of the person's latest message. */
export function latestWebChoice(messages: ReadonlyArray<{ role: string; metadata?: unknown }>): WebChoice | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "user") return webChoiceOf(message.metadata);
	}
	return undefined;
}

/**
 * The mode of the reply to these messages. A message with no choice (an older chat, or a
 * client that sends none) searches the web, as every reply did before.
 */
export function webModeFor(messages: ReadonlyArray<{ role: string; metadata?: unknown }>): WebMode {
	return latestWebChoice(messages)?.web ?? "search";
}

/** What the chat stays on after a message with this choice. */
export function keptMode(choice: WebChoice, fallback: KeptWebMode): KeptWebMode {
	return choice.keep ?? (choice.web === "research" ? fallback : choice.web);
}

/**
 * Deep research runs on Perplexity's research model, through OpenRouter on a Zero Data
 * Retention endpoint like every model call. It plans, searches and reads the web for minutes
 * before its first word (server/workflow/model-errors.ts gives it 30 minutes), and returns
 * the pages it used as sources, which its text cites as [1], [2] (web/citations.ts links them).
 */
export const RESEARCH_MODEL = { id: "perplexity/sonar-deep-research", name: "Deep research" };
