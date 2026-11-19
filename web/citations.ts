import type { UIMessage } from "ai";

/**
 * Deep research's reply (server/workflow/chat.ts) cites its pages by number, like [3], and
 * comes with those pages as its sources, in that order: [1] is the first. Each number becomes
 * a link to its page, so the reply reads as a cited report. A number with no page, or one that
 * is already a link, stays as it is. Other replies have no sources and come back unchanged.
 */
export function withCitationLinks(message: UIMessage): UIMessage {
	const urls = message.parts.filter((part) => part.type === "source-url").map((part) => part.url);
	if (urls.length === 0) return message;
	return {
		...message,
		parts: message.parts.map((part) => (part.type === "text" ? { ...part, text: linkNumbers(part.text, urls) } : part)),
	};
}

/** `[3]` not already a link's text (`[3](`) or inside one (`[[3]]`). The page's address goes in angle brackets: it may hold spaces or parentheses. */
function linkNumbers(text: string, urls: string[]) {
	return text.replace(/(?<!\[)\[(\d{1,3})\](?![(\]])/g, (marker, number: string) => {
		const url = urls[Number(number) - 1];
		return url ? `[${marker}](<${url.replace(/[<>]/g, encodeURIComponent)}>)` : marker;
	});
}
