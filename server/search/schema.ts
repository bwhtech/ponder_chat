import { z } from "zod";

/**
 * What the model sees of web_search and web_fetch: names, descriptions and inputs. These
 * stay the same whatever backend runs a search (backend.ts). Kept apart from tool.ts
 * because the chat workflow imports it, and workflow code cannot load Node modules.
 */
export const WEB_SEARCH = "web_search";
export const WEB_FETCH = "web_fetch";
/** In a workspace chat with the web off: shows the person a button that searches the web for their question. */
export const OFFER_WEB_SEARCH = "offer_web_search";

export const webSearchInput = z.object({
	query: z
		.string()
		.min(2)
		.max(400)
		.describe("What to search for, as you would type it in a search engine. Leave out the person's name and other private details."),
});

export const webFetchInput = z.object({
	url: z.string().url().describe("The full http or https address of the page to read."),
});

export type WebSearchInput = z.infer<typeof webSearchInput>;
export type WebFetchInput = z.infer<typeof webFetchInput>;

export const WEB_SEARCH_DESCRIPTION =
	"Search the web. Returns numbered results, each with a title, an address and text from the page. " +
	"Use it for recent events, prices, versions, facts you are not sure of, and anything after your training data. " +
	"Not for things you already know well. Search again with other words if the results do not answer the question.";

export const WEB_FETCH_DESCRIPTION =
	"Read one web page: returns its title and main text. Use it for an address the person gives, " +
	"or to read a search result in full when its excerpt is not enough.";

/** web_search under deep research (shared/web-mode.ts): the same tool and input, a slower and wider search. */
export const DEEP_SEARCH_DESCRIPTION =
	"Search the web in depth. Returns numbered results, each with a title, an address and text from the page. " +
	"Each search takes several seconds and reads more of the web than a quick search, so ask a full question, not two or three keywords. " +
	"Search again for another part of the question, or with other words if the results do not answer it.";

export const offerWebSearchInput = z.object({
	missing: z.string().min(1).max(200).describe("What the workspace's documents do not cover, in a few words, like city permits for street events."),
});

export const OFFER_WEB_SEARCH_DESCRIPTION =
	"Show the person a button that searches the web for their question. Web search is off in this chat, and only they can turn it on. " +
	"Call it once, before you answer, when the workspace's documents do not have the answer or have only part of it. It searches nothing by itself.";
