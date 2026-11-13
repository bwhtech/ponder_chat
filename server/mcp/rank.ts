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
 *    word with an ending ("issues", "ordered", "listing", "creating"), and adds the
 *    weight of each field it matches. Filler words such as "the" and "for" match
 *    nothing, in the query or in a tool, so "weather forecast" does not find a tool that
 *    is "for" orders. Descriptions and names also keep each word whole, so "github"
 *    finds a description that says "GitHub".
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

/** Only this many of a query's words count: each word is scored against every tool, in the one server process. */
export const MAX_QUERY_WORDS = 16;

export function rank<T extends Rankable>(query: string, tools: readonly T[]): T[] {
	const terms = [...new Set(words(query.slice(0, MAX_QUERY_CHARS)))].slice(0, MAX_QUERY_WORDS);
	const scoring = scoringTerms(terms);
	return tools
		.map((tool) => ({ tool, tier: tierOf(terms, prepared(tool)), score: score(scoring, prepared(tool).fields) }))
		.filter((entry) => entry.score > 0 || entry.tier < Tier.keyword)
		.sort((a, b) => a.tier - b.tier || b.score - a.score || order(a.tool.connector.slug, b.tool.connector.slug) || order(a.tool.name, b.tool.name))
		.map((entry) => entry.tool);
}

/** connector_search takes at most this many characters; a longer text is cut here too. */
export const MAX_QUERY_CHARS = 300;

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
	return wholeWords(
		text
			.normalize("NFC")
			.replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
			.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2"),
	);
}

/**
 * Words split only at spaces and punctuation, not at camelCase. Marks stay in their
 * word, so Hindi words stay whole. A "word" of marks alone, such as the variation
 * selector in "✏️", is dropped. Thai and Chinese have no spaces, so a phrase in them is
 * one word: a query finds it only by its start.
 */
function wholeWords(text: string): string[] {
	return text
		.normalize("NFC")
		.toLowerCase()
		// Zero-width joiners stay too: Persian writes some words with U+200C, and Hindi some conjuncts with U+200D.
		.split(/[^\p{L}\p{M}\p{N}\u200C\u200D]+/u)
		.filter((word) => /[\p{L}\p{N}]/u.test(word));
}

const Tier = { exact: 0, exactWithoutSlug: 1, connector: 2, namePrefix: 3, keyword: 4 } as const;

function tierOf(terms: string[], { full, local, slug, connectorName }: Prepared) {
	if (sameWords(full, terms)) return Tier.exact;
	if (sameWords(local, terms)) return Tier.exactWithoutSlug;
	if (startsWithWholeWords(slug, terms) || startsWithWholeWords(connectorName, terms)) return Tier.connector;
	if (startsWithWords(full, terms) || startsWithWords(local, terms)) return Tier.namePrefix;
	return Tier.keyword;
}

/** A tool's words, split once for every search of the catalog (catalogs are recorded data, so a tool object never changes). */
type Prepared = { full: string[]; local: string[]; slug: string[]; connectorName: string[]; fields: Field[] };
const preparedTools = new WeakMap<Rankable, Prepared>();

function prepared(tool: Rankable): Prepared {
	let entry = preparedTools.get(tool);
	if (!entry) {
		entry = { full: words(tool.name), local: words(tool.tool), slug: words(tool.connector.slug), connectorName: words(tool.connector.name), fields: fields(tool) };
		preparedTools.set(tool, entry);
	}
	return entry;
}

/** Words that say nothing about which tool the query wants. */
const FILLER = new Set(["a", "an", "and", "for", "in", "is", "me", "my", "of", "or", "please", "the", "to", "with"]);

/** One-letter and filler words match almost anything by prefix, so they score only when they are all the query has. */
function scoringTerms(terms: string[]) {
	const meaningful = terms.filter((term) => term.length > 1 && !FILLER.has(term));
	return meaningful.length ? meaningful : terms;
}

/** A field's words, its pairs of adjacent words joined (pairs), and its weight. */
type Field = [words: string[], pairs: string[], weight: number];

function fields(tool: Rankable): Field[] {
	const properties = isObject(tool.inputSchema.properties) ? Object.entries(tool.inputSchema.properties) : [];
	const propertyDescriptions = properties.flatMap(([, schema]) => (isObject(schema) && typeof schema.description === "string" ? [schema.description] : []));
	return [
		[meaningful(words(tool.tool)), pairs(words(tool.tool)), 6],
		[meaningful([...words(tool.connector.slug), ...prose(tool.connector.name)]), [], 4],
		[meaningful(properties.flatMap(([key]) => words(key))), properties.flatMap(([key]) => pairs(words(key))), 3],
		[meaningful(prose(`${tool.title ?? ""} ${tool.description}`)), [], 2],
		[meaningful(propertyDescriptions.flatMap(prose)), [], 1],
		[meaningful(prose(tool.connector.server ?? "")), [], 1],
	];
}

function score(terms: string[], fields: Field[]) {
	let total = 0;
	for (const term of terms) {
		for (const [list, joinedPairs, weight] of fields) if (list.some((word) => matches(word, term)) || joinedPairs.some((pair) => pair === term || formOf(pair, term))) total += weight;
	}
	return total;
}

/** The query word starts the word ("repo" finds repositories), or is the word with an ending ("issues" finds issue). */
const matches = (word: string, term: string) => word.startsWith(term) || formOf(word, term);

/**
 * True when the term is a form of the word: a plural (id → ids, issue → issues, category →
 * categories), a past (create → created, order → ordered, copy → copied, stop →
 * stopped) or an "-ing" (list → listing, create → creating, see → seeing, run →
 * running). Only "s" and "es" work on two-letter words: short words with the other
 * endings are other words ("ad" and "add", "be" and "bing", "car" and "card").
 */
function formOf(word: string, term: string) {
	if (word.length < 2) return false;
	if (term === `${word}s` || term === `${word}es`) return true;
	if (word.length < 3 || STANDALONE.has(term)) return false;
	return formsOf(word).includes(term);
}

function formsOf(word: string): string[] {
	const last = word.at(-1)!;
	// see → seeing, agree → agreed; but "fee" and "feed", "see" and "seed" are other words.
	if (word.endsWith("ee")) return [`${word}ing`, ...(word.length > 3 ? [`${word}d`] : [])];
	// create → created, creating.
	if (last === "e") return [`${word}d`, `${word.slice(0, -1)}ing`];
	// category → categories; copy → copied, copying.
	if (last === "y" && !VOWELS.has(word.at(-2)!)) return [`${word.slice(0, -1)}ies`, `${word.slice(0, -1)}ied`, `${word}ing`];
	const forms = [`${word}ed`, `${word}ing`];
	// ship → shipped, shipping; run → running. A short word that ends in one vowel and a consonant doubles it.
	if (word.length <= 4 && !VOWELS.has(last) && !"wxy".includes(last) && VOWELS.has(word.at(-2)!) && !VOWELS.has(word.at(-3)!)) forms.push(`${word}${last}ed`, `${word}${last}ing`);
	return forms;
}

const VOWELS = new Set("aeiou");

/** Words that end like a form but are words of their own: "being" is not "bee", "incoming" is not "income". */
const STANDALONE = new Set(["being", "incoming", "outgoing", "upcoming", "ongoing", "during", "nothing", "something", "anything", "everything", "evening", "morning", "string"]);

/**
 * Each pair of a name's adjacent words joined, so "github" finds searchGitHub and
 * gitHubRepo. A pair matches only the whole query word, or it with an ending: by its
 * start, "card" would find get_car_details and "todo" move_to_done.
 */
function pairs(list: string[]) {
	return list.slice(1).map((word, index) => `${list[index]}${word}`);
}

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

/** A description's or a name's words, split at camelCase and also whole ("GitHub": git, hub, github), without one-letter words such as "a". */
const prose = (text: string) => [...new Set([...words(text), ...wholeWords(text)])].filter((word) => word.length > 1);

/** The same order in every locale. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
