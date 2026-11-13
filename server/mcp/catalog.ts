import { closestNames, rank, type Rankable } from "./rank.ts";
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
	/**
	 * On, but it has no tools now: its sign-in ended ("sign-in"), or its server failed
	 * ("error"; Ponder tries it again every few minutes). It stays in the catalog, so the
	 * model's tools and instructions don't change while it is down.
	 */
	unavailable?: "sign-in" | "error";
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
	/** Connectors that were not searched, and why. */
	unavailable?: string[];
	message?: string;
};

const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 25;
const MAX_RESULT_DESCRIPTION = 600;
/** At most this much of a search's output, in characters of JSON: results past it count as remaining. */
const MAX_OUTPUT_CHARS = 20_000;

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
		const unavailable = this.data.connectors.filter((connector) => connector.unavailable).map(unavailableLine);
		const scoped = this.scope(query);
		if ("message" in scoped) return { results: [], remaining: 0, searched: 0, message: scoped.message };
		// Only a blank query, or "slug__" alone, lists every tool: a query in words that match nothing finds nothing.
		const found = scoped.query.trim() ? rank(scoped.query, scoped.tools) : [...scoped.tools].sort((a, b) => (a.name < b.name ? -1 : 1));
		const output = this.fit(found.slice(0, count).map(toResult), {
			searched: scoped.tools.length,
			...(unavailable.length && { unavailable }),
			...(!found.length && { message: this.data.tools.length ? "Nothing matched. Try other words, or a connector's slug followed by __." : "The person's connectors have no tools on." }),
		});
		return { ...output, remaining: found.length - output.results.length };
	}

	/** Finds the tool by its exact name, and checks the input against its schema. */
	check(call: { tool?: unknown; input?: unknown }): Checked {
		if (typeof call.tool !== "string" || !call.tool) return { problem: "Name the tool to call, as connector_search returns it." };
		// The exact name only: needsApproval looks the tool up by the same name, so a padded name must not find it here.
		const tool = this.get(call.tool);
		if (!tool) return { problem: this.unknown(call.tool) };
		const input = call.input ?? {};
		if (typeof input !== "object" || Array.isArray(input)) return { problem: `The input for ${tool.name} must be an object. Signature: ${signature(tool.name, tool.inputSchema)}` };
		const problems = inputProblems(tool.inputSchema, input);
		if (problems.length) return { problem: `The input for ${tool.name} does not fit the tool: ${problems.join("; ")}. Signature: ${signature(tool.name, tool.inputSchema)}` };
		return { tool, input: input as Record<string, unknown> };
	}

	private unknown(name: string) {
		const slug = name.includes("__") ? name.slice(0, name.indexOf("__")) : undefined;
		const connector = this.data.connectors.find((each) => each.slug === slug);
		if (connector?.unavailable) return `${unavailableText(connector)} Tell the person, and don't try its tools again in this reply.`;
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
		if (connector.unavailable) return { message: `${unavailableText(connector)} Tell the person.` };
		return { query: `${match[2]}${match[3]}`, tools: this.data.tools.filter((tool) => tool.connector.slug === slug) };
	}

	/** The results and their servers' notes, cut to MAX_OUTPUT_CHARS. The first result always stays. */
	private fit(results: SearchResult[], rest: Omit<SearchOutput, "results" | "remaining">): Omit<SearchOutput, "remaining"> {
		for (let kept = results.length; ; kept--) {
			const output = { results: results.slice(0, kept), ...rest, ...this.notesFor(results.slice(0, kept)) };
			if (kept <= 1 || JSON.stringify(output).length <= MAX_OUTPUT_CHARS) return output;
		}
	}

	private notesFor(results: SearchResult[]) {
		const slugs = new Set(results.map((result) => result.connector));
		const serverNotes = this.data.connectors.filter((connector) => slugs.has(connector.slug) && connector.notes).map((connector) => ({ connector: connector.slug, notes: connector.notes! }));
		return serverNotes.length ? { serverNotes } : {};
	}
}

/** Why a connector has no tools now, for the model. */
export function unavailableText(connector: CatalogConnector) {
	return connector.unavailable === "sign-in"
		? `${connector.name} needs the person to sign in again, in Settings, Connectors.`
		: `${connector.name}'s server is failing. Ponder tries it again every few minutes.`;
}

const unavailableLine = (connector: CatalogConnector) => `${connector.slug}: ${connector.unavailable === "sign-in" ? "needs a new sign-in" : "its server is failing"}`;

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
