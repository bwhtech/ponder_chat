/**
 * Ranks connector tools for connector_search, and finds the closest names when the
 * model calls a name that does not exist. Based on vercel/eve's catalog ranker
 * (packages/eve/src/execution/catalog/rank.ts). No imports: the workflow loads it.
 *
 * The query and each name split into lowercase words at camelCase, `_` and punctuation,
 * so "create issue", "createIssue" and "create_issue" are the same words. Matches come
 * in tiers:
 *
 * 1. Exact: the query's words are the tool's full name, such as linear__create_issue.
 * 2. Exact without the slug: create_issue finds linear__create_issue.
 * 3. Connector: the query is the connector's slug or name, or starts it with whole
 *    words. "linear" lists Linear's tools; "git" leaves GitHub's to the next tiers.
 * 4. Name prefix: the name starts with the query's words, and the last word may be
 *    cut, so "create_iss" finds create_issue.
 * 5. Keyword: any other match. A query word matches a word that it starts, or the
 *    word with a plural ending ("issues" matches issue), and adds the weight of each
 *    field it matches. Filler words such as "the" and "for" match nothing, in the query
 *    or in a tool, so "weather forecast" does not find a tool that is "for" orders.
 *
 * In a tier, a higher keyword score comes first, then the connector, then the name.
 */

/** What the ranker reads of one tool. */
export type Rankable = {
	/** The full name, such as linear__create_issue. */
	name: string;
	/** The MCP tool's own name, such as create_issue. */
	tool: string;
	title?: string;
	description: string;
	inputSchema: Record<string, unknown>;
	connector: { slug: string; name: string; server?: string };
};

export function rank<T extends Rankable>(query: string, tools: readonly T[]): T[] {
	const terms = words(query);
	const scoring = scoringTerms(terms);
	return tools
		.map((tool) => ({ tool, tier: tierOf(terms, tool), score: score(scoring, fields(tool)) }))
		.filter((entry) => entry.score > 0 || entry.tier < Tier.keyword)
		.sort((a, b) => a.tier - b.tier || b.score - a.score || order(a.tool.connector.slug, b.tool.connector.slug) || order(a.tool.name, b.tool.name))
		.map((entry) => entry.tool);
}

const MAX_SUGGESTIONS = 5;

/** The names closest to a name that is not in the catalog, best first. */
export function closestNames(name: string, tools: readonly Rankable[]): string[] {
	if (!words(name).length) return [];
	return rank(name, tools)
		.slice(0, MAX_SUGGESTIONS)
		.map((tool) => tool.name);
}

/** Every word of a name or a query, lowercase, in any script: "订单" and "créer" are words too. */
export function words(text: string): string[] {
	return text
		.replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
		.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

const Tier = { exact: 0, exactWithoutSlug: 1, connector: 2, namePrefix: 3, keyword: 4 } as const;

function tierOf(terms: string[], tool: Rankable) {
	const full = words(tool.name);
	const local = words(tool.tool);
	if (sameWords(full, terms)) return Tier.exact;
	if (sameWords(local, terms)) return Tier.exactWithoutSlug;
	if (startsWithWholeWords(words(tool.connector.slug), terms) || startsWithWholeWords(words(tool.connector.name), terms)) return Tier.connector;
	if (startsWithWords(full, terms) || startsWithWords(local, terms)) return Tier.namePrefix;
	return Tier.keyword;
}

/** Words that say nothing about which tool the query wants. */
const FILLER = new Set(["a", "an", "and", "for", "in", "is", "me", "my", "of", "or", "please", "the", "to", "with"]);

/** One-letter and filler words match almost anything by prefix, so they score only when they are all the query has. */
function scoringTerms(terms: string[]) {
	const meaningful = terms.filter((term) => term.length > 1 && !FILLER.has(term));
	return meaningful.length ? meaningful : terms;
}

type Field = [words: string[], weight: number];

function fields(tool: Rankable): Field[] {
	const properties = isObject(tool.inputSchema.properties) ? Object.entries(tool.inputSchema.properties) : [];
	const propertyDescriptions = properties.flatMap(([, schema]) => (isObject(schema) && typeof schema.description === "string" ? [schema.description] : []));
	return [
		[meaningful(words(tool.tool)), 6],
		[meaningful([...words(tool.connector.slug), ...words(tool.connector.name)]), 4],
		[meaningful(properties.flatMap(([key]) => words(key))), 3],
		[meaningful(prose(`${tool.title ?? ""} ${tool.description}`)), 2],
		[meaningful(propertyDescriptions.flatMap(prose)), 1],
		[meaningful(prose(tool.connector.server ?? "")), 1],
	];
}

function score(terms: string[], fields: Field[]) {
	let total = 0;
	for (const term of terms) for (const [list, weight] of fields) if (list.some((word) => matches(word, term))) total += weight;
	return total;
}

/** The query word starts the word ("repo" finds repositories), or is the word with a plural ending ("issues" finds issue). */
const matches = (word: string, term: string) => word.startsWith(term) || PLURAL_ENDINGS.some((ending) => term === `${word}${ending}`);
const PLURAL_ENDINGS = ["s", "es"];

/** A tool's words without filler: "for" in a description must not match "forecast". */
const meaningful = (list: string[]) => list.filter((word) => !FILLER.has(word));

function sameWords(list: string[], terms: string[]) {
	return list.length === terms.length && startsWithWholeWords(list, terms);
}

function startsWithWholeWords(list: string[], terms: string[]) {
	return terms.length > 0 && terms.length <= list.length && terms.every((term, index) => list[index] === term);
}

/** The last term may be a cut word. */
function startsWithWords(list: string[], terms: string[]) {
	return terms.length > 0 && terms.length <= list.length && terms.every((term, index) => (index === terms.length - 1 ? list[index]!.startsWith(term) : list[index] === term));
}

/** A description's words, without one-letter words such as "a". */
const prose = (text: string) => words(text).filter((word) => word.length > 1);

/** The same order in every locale. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
