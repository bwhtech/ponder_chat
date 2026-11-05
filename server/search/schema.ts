import { z } from "zod";

/**
 * What the model sees of web_search and web_fetch: names, descriptions and inputs. These
 * stay the same whatever backend runs a search (backend.ts). Kept apart from tool.ts
 * because the chat workflow imports it, and workflow code cannot load Node modules.
 */
export const WEB_SEARCH = "web_search";
export const WEB_FETCH = "web_fetch";

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
