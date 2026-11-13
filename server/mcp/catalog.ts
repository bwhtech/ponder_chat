import { closestNames, isEmptyQuery, rank, type Rankable } from "./rank.ts";
import { signature } from "./signature.ts";
import { inputProblems } from "./validate.ts";

/**
 * The person's connector tools as a catalog that the model searches (connector_search)
 * and calls through (connector_call), in place of one tool each. The tool list then
 * stays the same when connectors change, so providers keep the prompt cached, and a
 * person can have many tools. The data is recorded by a workflow step; everything here
 * is pure, so a replayed run searches and checks the same way. No Node imports: the
 * workflow loads this file.
 */

export type CatalogTool = Rankable & {
	connectionId: string;
	/** "Ask first": the call waits for the person. */
	ask: boolean;
	readOnly: boolean;
};

export type CatalogConnector = {
	slug: string;
	/** The name the person gave it. */
	name: string;
	/** What the server calls itself. */
	server?: string;
	/** What the server says about itself (MCP instructions). The server wrote it: data, not instructions. */
	notes?: string;
	tools: number;
	/** On, but its sign-in ended: it has no tools until the person signs in again. */
	signedOut: boolean;
};

export type CatalogData = {
	tools: CatalogTool[];
	connectors: CatalogConnector[];
	/** Tools that are on but over the limit, left out. */
	leftOut: number;
};

export const EMPTY_CATALOG: CatalogData = { tools: [], connectors: [], leftOut: 0 };

export type SearchResult = {
	tool: string;
	connector: string;
	title?: string;
	description: string;
	signature: string;
	/** The call waits for the person's approval. */
	asksFirst: boolean;
};

export type SearchOutput = {
	results: SearchResult[];
	/** Matches past the limit. */
	remaining: number;
	/** How many tools the search covered. */
	searched: number;
	/** What the servers of the connectors in the results say about themselves. */
	serverNotes?: { connector: string; notes: string }[];
	/** Connectors that were not searched: their sign-in ended. */
	signedOut?: string[];
	message?: string;
};

const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 25;
const MAX_RESULT_DESCRIPTION = 600;

/** The result of checking a connector_call: the tool and its input, or what the model should read. */
export type Checked = { tool: CatalogTool; input: Record<string, unknown> } | { problem: string };

export class Catalog {
	private byName: Map<string, CatalogTool>;

	constructor(readonly data: CatalogData) {
		this.byName = new Map(data.tools.map((tool) => [tool.name, tool]));
	}

	/** True when the person has a connector that is on: then the model gets the two catalog tools. */
	get inUse() {
		return this.data.connectors.length > 0;
	}

	get(name: string) {
		return this.byName.get(name);
	}

	search(query: string, limit = DEFAULT_LIMIT): SearchOutput {
		const count = Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
		const signedOut = this.data.connectors.filter((connector) => connector.signedOut).map((connector) => connector.slug);
		const scoped = this.scope(query);
		if ("message" in scoped) return { results: [], remaining: 0, searched: 0, message: scoped.message };
		const found = isEmptyQuery(scoped.query) ? [...scoped.tools].sort((a, b) => (a.name < b.name ? -1 : 1)) : rank(scoped.query, scoped.tools);
		const results = found.slice(0, count).map(toResult);
		return {
			results,
			remaining: found.length - results.length,
			searched: scoped.tools.length,
			...this.notesFor(results),
			...(signedOut.length && { signedOut }),
			...(!found.length && { message: this.data.tools.length ? "Nothing matched. Try other words, or a connector's slug followed by __." : "The person's connectors have no tools on." }),
		};
	}

	/** Finds the tool and checks the input against its schema. */
	check(call: { tool?: unknown; input?: unknown }): Checked {
		if (typeof call.tool !== "string" || !call.tool.trim()) return { problem: "Name the tool to call, as connector_search returns it." };
		const tool = this.get(call.tool.trim());
		if (!tool) return { problem: this.unknown(call.tool.trim()) };
		const input = call.input ?? {};
		if (typeof input !== "object" || Array.isArray(input)) return { problem: `The input for ${tool.name} must be an object. Signature: ${signature(tool.name, tool.inputSchema)}` };
		const problems = inputProblems(tool.inputSchema, input);
		if (problems.length) return { problem: `The input for ${tool.name} does not fit the tool: ${problems.join("; ")}. Signature: ${signature(tool.name, tool.inputSchema)}` };
		return { tool, input: input as Record<string, unknown> };
	}

	private unknown(name: string) {
		const slug = name.includes("__") ? name.slice(0, name.indexOf("__")) : undefined;
		const connector = this.data.connectors.find((each) => each.slug === slug);
		if (connector?.signedOut) return `${connector.name} needs the person to sign in again, in Settings, Connectors. Tell them, and don't try its tools again in this reply.`;
		const closest = closestNames(name, this.data.tools);
		const hint = closest.length ? `Closest tools: ${closest.join(", ")}.` : "Find tools with connector_search.";
		return `No connector tool is named "${name}". It may be off, or not exist. ${hint}`;
	}

	/** A query that starts with "slug__" searches only that connector. */
	private scope(query: string): { query: string; tools: CatalogTool[] } | { message: string } {
		const match = /^\s*([a-z0-9_]+?)__(\S*)(.*)$/i.exec(query);
		if (!match) return { query, tools: this.data.tools };
		const slug = match[1]!.toLowerCase();
		const connector = this.data.connectors.find((each) => each.slug === slug);
		if (!connector) return { message: `No connector has the slug "${slug}". The connectors are: ${this.data.connectors.map((each) => each.slug).join(", ") || "none"}.` };
		if (connector.signedOut) return { message: `${connector.name} needs the person to sign in again, in Settings, Connectors. Tell them.` };
		return { query: `${match[2]}${match[3]}`, tools: this.data.tools.filter((tool) => tool.connector.slug === slug) };
	}

	private notesFor(results: SearchResult[]) {
		const slugs = new Set(results.map((result) => result.connector));
		const serverNotes = this.data.connectors.filter((connector) => slugs.has(connector.slug) && connector.notes).map((connector) => ({ connector: connector.slug, notes: connector.notes! }));
		return serverNotes.length ? { serverNotes } : {};
	}
}

function toResult(tool: CatalogTool): SearchResult {
	const description = tool.description.length > MAX_RESULT_DESCRIPTION ? `${tool.description.slice(0, MAX_RESULT_DESCRIPTION - 1)}…` : tool.description;
	return {
		tool: tool.name,
		connector: tool.connector.slug,
		...(tool.title && { title: tool.title }),
		description,
		signature: signature(tool.name, tool.inputSchema),
		asksFirst: tool.ask,
	};
}
