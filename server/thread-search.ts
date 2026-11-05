import { sql } from "./db.ts";

/**
 * Search in a person's own chats, with Postgres full-text search on `threads.search`
 * (db.ts). Each word matches as a prefix, so results come while the person types.
 * Every word must match; titles weigh more than messages. Up to 20 results, each with
 * a short excerpt where the words are marked.
 */
export type ThreadHit = { id: string; title: string; updatedAt: string; excerpt: string };

/** Marks around a matched word in an excerpt; characters from Unicode's private area, never in real text. */
export const MATCH_START = "";
export const MATCH_END = "";

const MAX_WORDS = 8;

export async function searchThreads(owner: string, query: string): Promise<ThreadHit[]> {
	const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_WORDS);
	if (!words.length) return [];
	// Only letters and digits reach to_tsquery, so its syntax can't be broken.
	const tsquery = words.map((word) => `${word}:*`).join(" & ");
	const rows = await sql<{ id: string; title: string | null; first: string | null; updated_at: Date; excerpt: string }[]>`
		with hits as (
			select id, title, updated_at, messages, ts_rank(search, q) as rank, q
			from threads, to_tsquery('simple', ${tsquery}) q
			where owner = ${owner} and search @@ q
			order by rank desc, updated_at desc
			limit 20
		)
		select id, title, updated_at,
			jsonb_path_query_first(messages, '$[*] ? (@.role == "user").parts[*] ? (@.type == "text").text') #>> '{}' as first,
			ts_headline('simple',
				(select string_agg(text, ' ') from jsonb_array_elements_text(jsonb_path_query_array(messages, '$[*].parts[*] ? (@.type == "text").text')) as text),
				q, ${`MaxFragments=1, MaxWords=24, MinWords=10, StartSel=${MATCH_START}, StopSel=${MATCH_END}`}) as excerpt
		from hits
		order by rank desc, updated_at desc`;
	return rows.map((row) => ({
		id: row.id,
		title: row.title || firstLine(row.first),
		updatedAt: row.updated_at.toISOString(),
		excerpt: (row.excerpt ?? "").replace(/\s+/g, " ").trim(),
	}));
}

function firstLine(text: string | null) {
	const line = (text ?? "").split("\n")[0].trim();
	return line ? line.slice(0, 80) : "New chat";
}
