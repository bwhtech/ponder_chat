import * as PgClient from "@effect/sql-pg/PgClient";
import { embed, embedMany } from "ai";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as PonderConfig from "../config.ts";
import { privateRouting } from "../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import type { UnreadableSecret } from "../secrets/Secrets.ts";
import { EmbeddingFailed, statusOf } from "./errors.ts";
import type { IndexedMemory, MemoryIndex } from "./types.ts";

/**
 * The search index for memories, in Ponder's own Postgres with pgvector. It holds only
 * text, owner and vectors, and can be rebuilt from `memories`. Search mixes meaning
 * (cosine distance) and words (full text with the 'simple' configuration, so any
 * language works), fused with reciprocal-rank fusion.
 *
 * Memories per person are few, so the person's rows are scanned exactly; no vector index
 * is needed, and the vector width follows the embedding model (PONDER_EMBEDDING_MODEL).
 *
 * The `embedding` column is never read: the client has no codec for a vector
 * (docs/effect.md, "Database"). Search computes the distance in SQL.
 */
const CANDIDATES = 50;
/** Reciprocal-rank fusion's constant: a rank r scores 1 / (K + r). */
const K = 60;

/** How the index can fail: the database, the embeddings, or the OpenRouter key. */
export type IndexError = SqlError | EmbeddingFailed | OpenRouterKey.NoOpenRouterKey | UnreadableSecret;

const IdRow = Schema.Struct({ id: Schema.String });
const CountRow = Schema.Struct({ count: Schema.Number });

/** The index, on the services of the environment it is made in. Its table is made on first use. */
export const makePgvectorIndex = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const config = yield* PonderConfig.PonderConfig;
	const keys = yield* OpenRouterKey.OpenRouterKey;
	const model = config.embeddingModel;

	// Made for each call, because the key can change (openrouter/OpenRouterKey.ts).
	const embedder = Effect.map(keys.provider, (provider) => provider.textEmbeddingModel(model, { provider: privateRouting }));
	const embeddingFailed = (cause: unknown) => new EmbeddingFailed({ model, status: statusOf(cause), cause });

	// Once per process; a failed migration is tried again on the next call.
	const migrated = yield* Ref.make(false);
	const migrating = yield* Semaphore.make(1);
	const migrate = migrating.withPermits(1)(
		Effect.gen(function* () {
			if (yield* Ref.get(migrated)) return;
			yield* sql`create extension if not exists vector`;
			yield* sql`
				create table if not exists memory_vectors (
					id text primary key,
					owner text not null,
					text text not null,
					embedding vector not null
				)`;
			yield* sql`create index if not exists memory_vectors_owner on memory_vectors (owner)`;
			yield* Ref.set(migrated, true);
		}),
	);

	const write = Effect.fnUntraced(function* (memories: IndexedMemory[]) {
		const embeddingModel = yield* embedder;
		const { embeddings } = yield* Effect.tryPromise({
			try: (signal) => embedMany({ model: embeddingModel, values: memories.map((m) => m.text), abortSignal: signal }),
			catch: embeddingFailed,
		});
		const rows = memories.map((m, i) => ({ ...m, embedding: vectorLiteral(embeddings[i]) }));
		if (!Arr.isArrayNonEmpty(rows)) return;
		yield* sql`
			insert into memory_vectors ${sql.insert(rows)}
			on conflict (id) do update set owner = excluded.owner, text = excluded.text, embedding = excluded.embedding`;
	});

	const findBest = SqlSchema.findAll({
		Request: Schema.Struct({ owner: Schema.String, query: Schema.String, vector: Schema.String, limit: Schema.Number }),
		Result: IdRow,
		execute: ({ owner, query, vector, limit }) => sql`
			with scoped as (select id, text, embedding from memory_vectors where owner = ${owner}),
			by_meaning as (
				select id, row_number() over (order by embedding <=> ${vector}::vector) as rank
				from scoped order by embedding <=> ${vector}::vector limit ${CANDIDATES}
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
			group by id order by sum(score) desc limit ${limit}`,
	});
	const findCount = SqlSchema.findAll({
		Request: Schema.Void,
		Result: CountRow,
		execute: () => sql`select count(*)::int as count from memory_vectors`,
	});

	// No spans of their own: they run inside memory.recall, memory.save and the Memory page's calls.
	const index: MemoryIndex<IndexError> = {
		name: "pgvector",
		upsert: Effect.fnUntraced(function* (memories: IndexedMemory[]) {
			yield* migrate;
			if (memories.length) yield* write(memories);
		}),
		remove: Effect.fnUntraced(function* (ids: string[]) {
			yield* migrate;
			if (ids.length) yield* sql`delete from memory_vectors where id in ${sql.in(ids)}`;
		}),
		search: Effect.fnUntraced(function* (owner: string, query: string, limit: number) {
			yield* migrate;
			const embeddingModel = yield* embedder;
			const { embedding } = yield* Effect.tryPromise({ try: (signal) => embed({ model: embeddingModel, value: query, abortSignal: signal }), catch: embeddingFailed });
			const rows = yield* findBest({ owner, query, vector: vectorLiteral(embedding), limit }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
			return rows.map((row) => row.id);
		}),
		rebuild: Effect.fnUntraced(function* (memories: IndexedMemory[]) {
			yield* migrate;
			yield* sql`delete from memory_vectors`;
			if (memories.length) yield* write(memories);
		}),
		count: Effect.gen(function* () {
			yield* migrate;
			const [row] = yield* findCount(undefined).pipe(Effect.catchTags({ SchemaError: Effect.die }));
			return row.count;
		}),
	};
	return index;
});

const vectorLiteral = (vector: number[]) => `[${vector.join(",")}]`;
