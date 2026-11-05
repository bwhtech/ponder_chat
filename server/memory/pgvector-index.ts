import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { embed, embedMany } from "ai";
import type { Sql } from "postgres";
import type { IndexedMemory, MemoryIndex } from "./types.ts";

/**
 * The search index for memories, in Ponder's own Postgres with pgvector. It holds only
 * text, owner and vectors, and can be rebuilt from `memories`. Search mixes meaning
 * (cosine distance) and words (full text with the 'simple' configuration, so any
 * language works), fused with reciprocal-rank fusion.
 *
 * Memories per person are few, so the person's rows are scanned exactly; no vector index
 * is needed, and the vector width follows the embedding model.
 */
const CANDIDATES = 50;
/** Reciprocal-rank fusion's constant: a rank r scores 1 / (K + r). */
const K = 60;

export function pgvectorIndex({ sql, model = process.env.PONDER_EMBEDDING_MODEL ?? "google/gemini-embedding-2" }: { sql: Sql; model?: string }): MemoryIndex {
	const embedder = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY }).textEmbeddingModel(model);
	let ready: Promise<void> | undefined;
	const migrate = () =>
		(ready ??= (async () => {
			await sql`create extension if not exists vector`;
			await sql`
				create table if not exists memory_vectors (
					id text primary key,
					owner text not null,
					text text not null,
					embedding vector not null
				)`;
			await sql`create index if not exists memory_vectors_owner on memory_vectors (owner)`;
		})().catch((error) => {
			ready = undefined;
			throw error;
		}));

	async function write(memories: IndexedMemory[]) {
		const { embeddings } = await embedMany({ model: embedder, values: memories.map((m) => m.text) });
		await sql`
			insert into memory_vectors ${sql(memories.map((m, i) => ({ ...m, embedding: vectorLiteral(embeddings[i]) })))}
			on conflict (id) do update set owner = excluded.owner, text = excluded.text, embedding = excluded.embedding`;
	}

	return {
		name: "pgvector",
		async upsert(memories) {
			await migrate();
			if (memories.length) await write(memories);
		},
		async remove(ids) {
			await migrate();
			if (ids.length) await sql`delete from memory_vectors where id in ${sql(ids)}`;
		},
		async search(owner, query, limit) {
			await migrate();
			const { embedding } = await embed({ model: embedder, value: query });
			const rows = await sql<{ id: string }[]>`
				with scoped as (select id, text, embedding from memory_vectors where owner = ${owner}),
				by_meaning as (
					select id, row_number() over (order by embedding <=> ${vectorLiteral(embedding)}::vector) as rank
					from scoped order by embedding <=> ${vectorLiteral(embedding)}::vector limit ${CANDIDATES}
				),
				by_words as (
					select id, row_number() over (order by ts_rank(to_tsvector('simple', text), q) desc) as rank
					from scoped, plainto_tsquery('simple', ${query}) q
					where to_tsvector('simple', text) @@ q
					order by ts_rank(to_tsvector('simple', text), q) desc limit ${CANDIDATES}
				)
				select id from (
					select id, 1.0 / (${K} + rank) as score from by_meaning
					union all
					select id, 1.0 / (${K} + rank) from by_words
				) ranked
				group by id order by sum(score) desc limit ${limit}`;
			return rows.map((row) => row.id);
		},
		async rebuild(memories) {
			await migrate();
			await sql`delete from memory_vectors`;
			if (memories.length) await write(memories);
		},
		async count() {
			await migrate();
			const [row] = await sql<{ count: number }[]>`select count(*)::int as count from memory_vectors`;
			return row.count;
		},
	};
}

const vectorLiteral = (vector: number[]) => `[${vector.join(",")}]`;
