import { randomUUID } from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as PonderConfig from "../config.ts";
import { problem, recoverAll } from "./errors.ts";
import { KINDS, makeLlmExtractor, quotedIn, type Decision, type ExistingMemory, type Extractor, type MemoryKind, type Operation } from "./extract.ts";
import { makePgvectorIndex, type IndexError } from "./pgvector-index.ts";
import { saveLog, type AppliedOperation, type MemorySave } from "./save-log.ts";
import type { IndexedMemory, MemoryAdapter, MemoryFact, MemoryIndex, MemoryScope, MemorySnapshot, MemoryTurn, RecallResult, SaveReceipt } from "./types.ts";

export type { AppliedOperation, MemorySave } from "./save-log.ts";

/**
 * Ponder's memory adapter. Memories live in Postgres, the source of truth that the Memory
 * page edits. An optional index (pgvector) finds the relevant ones once there are too
 * many to put all in the prompt; without it, or if it fails, Postgres full-text search does.
 *
 * Every memory is one person's: the scope's `userId` is the owner. Unlike TanStack's
 * built-in stores, recall does not match `threadId`: memory is for what carries across chats.
 *
 * Nothing is deleted. A forgotten memory gets `forgotten_at`: recall leaves it out, and the
 * writer sees it as something not to add again. Every save is logged with what it changed
 * (save-log.ts), the text before an update included, so it can be undone.
 */
export type StoredMemory = {
	id: string;
	kind: MemoryKind;
	text: string;
	reason: string | null;
	sourceThread: string | null;
	sourceMessage: string | null;
	createdAt: string;
	updatedAt: string;
};

export type MemoryStoreOptions = {
	extract: Extractor;
	index?: MemoryIndex<IndexError>;
	/** Up to this many memories, recall gives all of them. Defaults to 30. */
	recallAll?: number;
	/** Above that, how many recall finds. Defaults to 8. */
	topK?: number;
	/** Above `recallAll`, how many related memories the gate and writer see when saving. Defaults to 15. */
	saveContext?: number;
	/** How many forgotten memories the writer sees, newest first. Defaults to 20. */
	forgottenLimit?: number;
};

const MemoryRow = Schema.Struct({
	id: Schema.String,
	owner: Schema.String,
	kind: Schema.Literals(KINDS),
	text: Schema.String,
	reason: Schema.NullOr(Schema.String),
	source_thread: Schema.NullOr(Schema.String),
	source_message: Schema.NullOr(Schema.String),
	created_at: Schema.Date,
	updated_at: Schema.Date,
	forgotten_at: Schema.NullOr(Schema.Date),
});
export type Row = typeof MemoryRow.Type;
const EditedRow = Schema.Struct({ ...MemoryRow.fields, previous: Schema.String });
const TextRow = Schema.Struct({ text: Schema.String });
const IdRow = Schema.Struct({ id: Schema.String });

export class MemoryStore extends Context.Service<
	MemoryStore,
	MemoryAdapter<SqlError> & {
		readonly name: string;
		readonly recall: (scope: MemoryScope, query: string) => Effect.Effect<RecallResult, SqlError>;
		readonly save: (scope: MemoryScope, turn: MemoryTurn) => Effect.Effect<SaveReceipt[], SqlError>;
		readonly inspect: (scope: MemoryScope) => Effect.Effect<MemorySnapshot, SqlError>;
		readonly listFacts: (scope: MemoryScope) => Effect.Effect<MemoryFact[], SqlError>;
		/** False when the memory is not in this scope. */
		readonly update: (scope: MemoryScope, id: string, text: string) => Effect.Effect<boolean, SqlError>;
		/** False when the memory is not in this scope, or forgotten already. */
		readonly forget: (scope: MemoryScope, id: string) => Effect.Effect<boolean, SqlError>;
		/** The operations it reversed; none when the save is not in this scope or was undone already (save-log.ts). */
		readonly undo: (scope: MemoryScope, saveId: number) => Effect.Effect<Option.Option<AppliedOperation[]>, SqlError>;
		/** The scope's save decisions, newest first; for one chat when given. */
		readonly saves: (scope: MemoryScope, options?: { threadId?: string; limit?: number }) => Effect.Effect<MemorySave[], SqlError>;
		/** Creates the tables of memories and of the save log. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** Rebuilds the index from Postgres when the two disagree. */
		readonly syncIndex: Effect.Effect<void, IndexError>;
		/** The person's memories, for the Memory page. */
		readonly list: (scope: MemoryScope) => Effect.Effect<StoredMemory[], SqlError>;
	}
>()("ponder/memory/MemoryStore") {}

/** A store with these parts, on the environment's database. The checks make their own with a stand-in extractor. */
export const makeWith = Effect.fnUntraced(function* ({ extract, index, recallAll = 30, topK = 8, saveContext = 15, forgottenLimit = 20 }: MemoryStoreOptions) {
	const sql = yield* PgClient.PgClient;
	const ownerOf = (scope: MemoryScope) => scope.userId ?? "";
	const logIndexError = (error: unknown) => Effect.logError("memory: search index update failed:", problem(error));

	const findScoped = SqlSchema.findAll({
		Request: Schema.String,
		Result: MemoryRow,
		execute: (owner) => sql`select * from memories where owner = ${owner} and forgotten_at is null order by updated_at desc`,
	});
	/** The memories in use: the person's, not forgotten. */
	const scoped = (scope: MemoryScope) => findScoped(ownerOf(scope)).pipe(Effect.catchTags({ SchemaError: Effect.die }));

	const findForgotten = SqlSchema.findAll({
		Request: Schema.String,
		Result: TextRow,
		execute: (owner) => sql`
			select text from memories where owner = ${owner} and forgotten_at is not null order by forgotten_at desc limit ${forgottenLimit}`,
	});
	const forgottenIn = (scope: MemoryScope) =>
		findForgotten(ownerOf(scope)).pipe(
			Effect.map((rows) => rows.map((row) => row.text)),
			Effect.catchTags({ SchemaError: Effect.die }),
		);

	const findWords = SqlSchema.findAll({
		Request: Schema.Struct({ owner: Schema.String, query: Schema.String, limit: Schema.Number }),
		Result: IdRow,
		execute: ({ owner, query, limit }) => sql`
			select id from memories
			where owner = ${owner} and forgotten_at is null and to_tsvector('simple', text) @@ websearch_to_tsquery('simple', ${query})
			order by ts_rank(to_tsvector('simple', text), websearch_to_tsquery('simple', ${query})) desc, updated_at desc
			limit ${limit}`,
	});

	const search = Effect.fnUntraced(function* (scope: MemoryScope, query: string, rows: ReadonlyArray<Row>, limit = topK) {
		const byId = new Map(rows.map((row) => [row.id, row]));
		const known = (ids: ReadonlyArray<string>) => ids.map((id) => byId.get(id)).filter((row): row is Row => !!row);
		if (index) {
			const found = yield* index.search(ownerOf(scope), query, limit).pipe(
				Effect.map(known),
				Effect.catch((error) => Effect.as(Effect.logError("memory: index search failed, using Postgres:", problem(error)), [])),
			);
			if (found.length) return found;
		}
		const found = yield* findWords({ owner: ownerOf(scope), query, limit }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		const hits = known(found.map(({ id }) => id));
		return hits.length ? hits : rows.slice(0, limit);
	});

	const findByIds = SqlSchema.findAll({
		Request: Schema.Array(Schema.String),
		Result: MemoryRow,
		execute: (ids) => sql`select * from memories where id = any(${ids})`,
	});

	/** Brings the index up to date with applied operations. Gives the error, if any; the memories are saved either way. */
	const reindex = (applied: AppliedOperation[]): Effect.Effect<string | null> => {
		if (!index) return Effect.succeed(null);
		const done = applied.filter((op) => op.status === "applied");
		return Effect.gen(function* () {
			const changed = done.filter((op) => op.op !== "forget").map((op) => op.memoryId);
			if (changed.length) {
				const rows = yield* findByIds(changed).pipe(Effect.catchTags({ SchemaError: Effect.die }));
				yield* index.upsert(rows.map(toIndexed));
			}
			yield* index.remove(done.filter((op) => op.op === "forget").map((op) => op.memoryId));
			return null;
		}).pipe(Effect.catch((error) => Effect.as(logIndexError(error), problem(error))));
	};

	const log = saveLog({ sql, ownerOf, reindex });

	const findOld = SqlSchema.findOne({
		Request: Schema.String,
		Result: TextRow,
		execute: (id) => sql`select text from memories where id = ${id} for update`,
	});
	const findGone = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: TextRow,
		execute: (id) => sql`update memories set forgotten_at = now() where id = ${id} returning text`,
	});

	/** Applies the extractor's operations in one transaction, skipping any that name a memory outside the scope. */
	const apply = (scope: MemoryScope, turn: MemoryTurn, operations: Operation[], known: Set<string>) =>
		sql.withTransaction(
			Effect.gen(function* () {
				const results: AppliedOperation[] = [];
				for (const op of operations) {
					if (op.op !== "forget" && !quotedIn(turn.user, op.quote)) {
						results.push({ ...op, memoryId: op.op === "update" ? op.id : "", status: "skipped", note: "The quote is not in what the person said" });
					} else if (op.op === "add") {
						const id = randomUUID();
						yield* sql`
							insert into memories (id, owner, kind, text, reason, source_thread, source_message)
							values (${id}, ${ownerOf(scope)}, ${op.kind}, ${op.text}, ${op.reason}, ${scope.threadId}, ${turn.messageId ?? null})`;
						results.push({ ...op, memoryId: id, status: "applied" });
					} else if (!known.has(op.id)) {
						results.push({ ...op, memoryId: op.id, status: "skipped", note: "No such memory in this scope" });
					} else if (op.op === "update") {
						// The id is known in this scope, so its row is there: a missing one is a bug.
						const old = yield* findOld(op.id).pipe(Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die }));
						yield* sql`
							update memories set text = ${op.text}, reason = ${op.reason}, source_thread = ${scope.threadId},
								source_message = ${turn.messageId ?? null}, updated_at = now()
							where id = ${op.id}`;
						results.push({ ...op, memoryId: op.id, status: "applied", previousText: old.text });
					} else {
						const gone = yield* findGone(op.id).pipe(Effect.catchTags({ SchemaError: Effect.die }));
						results.push({ ...op, memoryId: op.id, status: "applied", note: Option.getOrUndefined(gone)?.text });
					}
				}
				return results;
			}),
		);

	const recall = Effect.fn("MemoryStore.recall")(function* (scope: MemoryScope, query: string) {
		const rows = yield* scoped(scope);
		if (!rows.length) return { systemPrompt: "", fragments: [] };
		const hits = rows.length <= recallAll ? rows : yield* search(scope, query, rows);
		return { systemPrompt: render(hits, rows.length), fragments: hits.map((row) => ({ text: row.text, source: row.id })) };
	});

	const save = Effect.fn("MemoryStore.save")(function* (scope: MemoryScope, turn: MemoryTurn) {
		const startedAt = yield* Clock.currentTimeMillis;
		const latency = Effect.map(Clock.currentTimeMillis, (now) => now - startedAt);
		const rows = yield* scoped(scope);
		// Any failure to decide, of the search, the gate or the writer, is logged as the decision.
		const decided = yield* Effect.gen(function* () {
			// With many memories, the gate and writer see only the ones related to the turn, so a save costs the same at 30 memories or 3,000.
			const related = rows.length <= recallAll ? rows : yield* search(scope, turn.user, rows, saveContext);
			const existing: ExistingMemory[] = related.map((row) => ({ id: row.id, kind: row.kind, text: row.text }));
			const decision = yield* extract({ scope, turn, existing, forgotten: yield* forgottenIn(scope) });
			return { ok: true as const, decision };
		}).pipe(recoverAll((error) => Effect.succeed({ ok: false as const, message: problem(error) })));
		if (!decided.ok) {
			yield* log.write(scope, turn, { summary: "Could not decide what to save", operations: [], model: null, ok: false, error: decided.message, startedAt });
			return [{ ok: false, error: decided.message, latencyMs: yield* latency }];
		}
		const { decision } = decided;

		const applied = yield* apply(scope, turn, decision.operations, new Set(rows.map((row) => row.id)));
		const indexError = yield* reindex(applied);
		yield* log.write(scope, turn, { summary: decision.summary, operations: applied, model: decision.model, ok: !indexError, error: indexError, startedAt });

		const done = applied.filter((op) => op.status === "applied");
		const latencyMs = yield* latency;
		if (indexError) return [{ ok: false, error: `Saved, but the search index failed: ${indexError}`, latencyMs, raw: decision }];
		return done.length ? done.map((op) => ({ ok: true, latencyMs, raw: op })) : [{ ok: true, latencyMs, raw: { summary: decision.summary } }];
	});

	const inspect = Effect.fn("MemoryStore.inspect")(function* (scope: MemoryScope) {
		const rows = yield* scoped(scope);
		return { takenAt: new Date(yield* Clock.currentTimeMillis).toISOString(), data: { memories: rows.map(toStored) } };
	});

	const listFacts = Effect.fn("MemoryStore.listFacts")(function* (scope: MemoryScope) {
		const rows = yield* scoped(scope);
		return rows.map((row): MemoryFact => ({ id: row.id, text: row.text, source: row.kind, createdAt: row.created_at.toISOString() }));
	});

	const findEdited = SqlSchema.findOneOption({
		Request: Schema.Struct({ id: Schema.String, owner: Schema.String, text: Schema.String }),
		Result: EditedRow,
		execute: ({ id, owner, text }) => sql`
			update memories m set text = ${text}, updated_at = now()
			from (select id, text as previous from memories where id = ${id} for update) old
			where m.id = old.id and m.owner = ${owner} and m.forgotten_at is null
			returning m.*, old.previous`,
	});

	const update = Effect.fn("MemoryStore.update")(function* (scope: MemoryScope, id: string, text: string) {
		const edited = yield* findEdited({ id, owner: ownerOf(scope), text }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		if (Option.isNone(edited)) return false;
		if (index) yield* index.upsert([toIndexed(edited.value)]).pipe(Effect.catch(logIndexError));
		yield* log.edit(scope, "Edited on the Memory page", {
			op: "update", id, text, quote: "", reason: "Edited by the person", memoryId: id, status: "applied", previousText: edited.value.previous,
		});
		return true;
	});

	const findForgot = SqlSchema.findOneOption({
		Request: Schema.Struct({ id: Schema.String, owner: Schema.String }),
		Result: MemoryRow,
		execute: ({ id, owner }) => sql`
			update memories set forgotten_at = now() where id = ${id} and owner = ${owner} and forgotten_at is null returning *`,
	});

	const forget = Effect.fn("MemoryStore.forget")(function* (scope: MemoryScope, id: string) {
		const row = yield* findForgot({ id, owner: ownerOf(scope) }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		if (Option.isNone(row)) return false;
		if (index) yield* index.remove([id]).pipe(Effect.catch(logIndexError));
		yield* log.edit(scope, "Forgotten on the Memory page", { op: "forget", id, reason: "Forgotten by the person", memoryId: id, status: "applied", note: row.value.text });
		return true;
	});

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists memories (
				id text primary key,
				owner text not null,
				kind text not null,
				text text not null,
				reason text,
				source_thread text,
				source_message text,
				created_at timestamptz not null default now(),
				updated_at timestamptz not null default now(),
				forgotten_at timestamptz
			)`;
		yield* sql`create index if not exists memories_owner on memories (owner, updated_at desc)`;
		yield* log.migrate;
	});

	const findInUse = SqlSchema.findAll({
		Request: Schema.Void,
		Result: MemoryRow,
		execute: () => sql`select * from memories where forgotten_at is null`,
	});

	const syncIndex = Effect.gen(function* () {
		if (!index) return;
		const rows = yield* findInUse(undefined).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		if ((yield* index.count) === rows.length) return;
		yield* index.rebuild(rows.map(toIndexed));
		yield* Effect.log(`memory: rebuilt the search index with ${rows.length} memories`);
	});

	const list = Effect.fn("MemoryStore.list")(function* (scope: MemoryScope) {
		const rows = yield* scoped(scope);
		return rows.map(toStored);
	});

	return MemoryStore.of({
		id: "postgres",
		name: index ? `Postgres + ${index.name ?? "search index"}` : "Postgres",
		recall,
		save,
		inspect,
		listFacts,
		update,
		forget,
		undo: log.undo,
		saves: log.list,
		migrate,
		syncIndex,
		list,
	});
});

/** Ponder's store: the gate and writer on OpenRouter, and the pgvector index unless PONDER_MEMORY_INDEX=off. */
const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const extract = yield* makeLlmExtractor;
	const index = config.memoryIndexEnabled ? yield* makePgvectorIndex : undefined;
	return yield* makeWith({ extract, index });
});

export const layer = Layer.effect(MemoryStore, make);

/**
 * The block for the system prompt. Each memory's text is JSON-quoted, as TanStack's
 * renderer does, so a saved sentence cannot break out of the list and pose as instructions.
 */
export function render(hits: ReadonlyArray<Pick<Row, "kind" | "text">>, total: number) {
	return [
		"Memory: what this person told you about themselves in earlier conversations.",
		"Use it when it is relevant; do not mention it unless asked. What the person says now always wins.",
		total > hits.length ? `These are the ${hits.length} most relevant of ${total} memories.` : "",
		hits.map((row, i) => `${i + 1}. [${row.kind}] ${JSON.stringify(row.text)}`).join("\n"),
	]
		.filter(Boolean)
		.join("\n\n");
}

function toStored(row: Row): StoredMemory {
	return {
		id: row.id,
		kind: row.kind,
		text: row.text,
		reason: row.reason,
		sourceThread: row.source_thread,
		sourceMessage: row.source_message,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
	};
}

function toIndexed(row: Row): IndexedMemory {
	return { id: row.id, owner: row.owner, text: row.text };
}
