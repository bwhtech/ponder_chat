import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlSchema from "effect/sql/SqlSchema";

/**
 * Search in a person's own chats, with Postgres full-text search on `threads.search`
 * (threads/Threads.ts). Each word matches as a prefix, so results come while the person
 * types. Every word must match; titles weigh more than messages. Up to 20 results, each
 * with a short excerpt where the words are marked.
 *
 * The tsvector column is only searched and ranked in SQL: the client can't read one raw.
 */
export type ThreadHit = { id: string; title: string; updatedAt: string; excerpt: string };

/** Marks around a matched word in an excerpt; characters from Unicode's private area, never in real text. */
export const MATCH_START = "";
export const MATCH_END = "";

const MAX_WORDS = 8;

const HitRow = Schema.Struct({
	id: Schema.String,
	title: Schema.NullOr(Schema.String),
	first: Schema.NullOr(Schema.String),
	updated_at: Schema.Date,
	excerpt: Schema.NullOr(Schema.String),
});
const Search = Schema.Struct({ owner: Schema.String, tsquery: Schema.String });

export const searchThreads = Effect.fn("ThreadSearch.search")(function* (owner: string, query: string) {
	const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_WORDS);
	if (!words.length) return [];
	const sql = yield* PgClient.PgClient;
	const find = SqlSchema.findAll({
		Request: Search,
		Result: HitRow,
		execute: ({ owner, tsquery }) => sql`
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
			order by rank desc, updated_at desc`,
	});
	// Only letters and digits reach to_tsquery, so its syntax can't be broken.
	const rows = yield* find({ owner, tsquery: words.map((word) => `${word}:*`).join(" & ") }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
	return rows.map(
		(row): ThreadHit => ({
			id: row.id,
			title: row.title || firstLine(row.first),
			updatedAt: row.updated_at.toISOString(),
			excerpt: (row.excerpt ?? "").replace(/\s+/g, " ").trim(),
		}),
	);
});

function firstLine(text: string | null) {
	const line = (text ?? "").split("\n")[0].trim();
	return line ? line.slice(0, 80) : "New chat";
}
