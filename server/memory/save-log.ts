import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlSchema from "effect/sql/SqlSchema";
import { KINDS, type Operation } from "./extract.ts";
import type { MemoryScope, MemoryTurn } from "./types.ts";

/**
 * The decision log, `memory_saves`: one row per save, "nothing to save" included, and per
 * edit or forget on the Memory page. Each row keeps the operations as applied, with the
 * text an update replaced, so `undo` can reverse the save.
 */
export type MemorySave = {
	id: number;
	threadId: string | null;
	messageId: string | null;
	summary: string;
	operations: AppliedOperation[];
	model: string | null;
	ok: boolean;
	error: string | null;
	ms: number;
	createdAt: string;
	/** When the person undid this save. */
	undoneAt: string | null;
	/** For an undo: the save it undid. */
	undoOf: number | null;
};

/**
 * An operation as it was applied, with the memory's text, for the log and the chat page.
 * `previousText` is the text an update replaced, so the update can be undone.
 */
export type AppliedOperation = Operation & { memoryId: string; status: "applied" | "skipped"; note?: string; previousText?: string };

type Entry = { summary: string; operations: AppliedOperation[]; model: string | null; ok: boolean; error: string | null; startedAt: number; undoOf?: number };

// The operations are Ponder's own, as it wrote them: only that each is an object is checked.
const Operations = Schema.mutable(Schema.Array(Schema.declare((value): value is AppliedOperation => Predicate.isObject(value))));
const SaveRow = Schema.Struct({
	id: Schema.Number,
	thread_id: Schema.NullOr(Schema.String),
	message_id: Schema.NullOr(Schema.String),
	summary: Schema.String,
	operations: Operations,
	model: Schema.NullOr(Schema.String),
	ok: Schema.Boolean,
	error: Schema.NullOr(Schema.String),
	ms: Schema.Number,
	created_at: Schema.Date,
	undone_at: Schema.NullOr(Schema.Date),
	undo_of: Schema.NullOr(Schema.Number),
});
const UndoneRow = Schema.Struct({ thread_id: Schema.NullOr(Schema.String), summary: Schema.String, operations: Operations });
const MemoryText = Schema.Struct({ kind: Schema.Literals(KINDS), text: Schema.String });

type SaveLogOptions<E> = {
	sql: PgClient.PgClient;
	ownerOf: (scope: MemoryScope) => string;
	/** Brings the search index up to date after an undo; gives its error, if any. */
	reindex: (applied: AppliedOperation[]) => Effect.Effect<string | null, E>;
};

/** The log, on the store's client. A row that does not decode is a bug: a defect. */
export function saveLog<E>({ sql, ownerOf, reindex }: SaveLogOptions<E>) {
	const write = Effect.fnUntraced(function* (scope: MemoryScope, turn: Partial<MemoryTurn>, entry: Entry) {
		const ms = (yield* Clock.currentTimeMillis) - entry.startedAt;
		yield* sql`
			insert into memory_saves (owner, thread_id, message_id, summary, operations, model, ok, error, ms, undo_of)
			values (${ownerOf(scope)}, ${scope.threadId || null}, ${turn.messageId ?? null}, ${entry.summary},
				${sql.json(entry.operations)}, ${entry.model}, ${entry.ok}, ${entry.error}, ${ms}, ${entry.undoOf ?? null})`;
	});

	const edit = Effect.fnUntraced(function* (scope: MemoryScope, summary: string, operation: AppliedOperation) {
		yield* write(scope, {}, { summary, operations: [operation], model: null, ok: true, error: null, startedAt: yield* Clock.currentTimeMillis });
	});

	const findUndone = SqlSchema.findOneOption({
		Request: Schema.Struct({ saveId: Schema.Number, owner: Schema.String }),
		Result: UndoneRow,
		execute: ({ saveId, owner }) => sql`
			update memory_saves set undone_at = now()
			where id = ${saveId} and owner = ${owner} and undone_at is null and undo_of is null
			returning thread_id, summary, operations`,
	});

	/**
	 * Reverses one of the person's saves, newest change first: an add is forgotten, an update
	 * gets its old text back, a forgotten memory comes back. A memory that changed since is
	 * left as it is. The undo is logged as a save of its own. Gives none when there is no
	 * such save in the scope, or it was undone already.
	 */
	const undo = Effect.fn("MemoryStore.undo")(function* (scope: MemoryScope, saveId: number) {
		const startedAt = yield* Clock.currentTimeMillis;
		const owner = ownerOf(scope);
		const result = yield* sql.withTransaction(
			Effect.gen(function* () {
				const found = yield* findUndone({ saveId, owner }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
				if (Option.isNone(found)) return Option.none();
				const save = found.value;
				const reversed: AppliedOperation[] = [];
				for (const op of save.operations.filter((o) => o.status === "applied").reverse()) reversed.push(yield* reverse(owner, op));
				return Option.some({ save, reversed });
			}),
		);
		if (Option.isNone(result)) return Option.none<AppliedOperation[]>();
		const { save, reversed } = result.value;
		const indexError = yield* reindex(reversed);
		yield* write({ ...scope, threadId: save.thread_id ?? "" }, {}, {
			summary: `Undid: ${save.summary}`, operations: reversed, model: null, ok: !indexError, error: indexError, startedAt, undoOf: saveId,
		});
		return Option.some(reversed);
	});

	/** The memories a statement returns, as reverse reads them. */
	const memoriesOf = <E, R>(statement: Effect.Effect<ReadonlyArray<unknown>, E, R>) =>
		statement.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MemoryText))), Effect.catchTags({ SchemaError: Effect.die }));

	/** Reverses one applied operation inside the undo's transaction. */
	const reverse = Effect.fnUntraced(function* (owner: string, op: AppliedOperation) {
		const where = sql`id = ${op.memoryId} and owner = ${owner}`;
		let reversed: AppliedOperation;
		if (op.op === "add") {
			const [row] = yield* memoriesOf(sql`update memories set forgotten_at = now() where ${where} and forgotten_at is null returning *`);
			reversed = row
				? { op: "forget", id: op.memoryId, reason: "Undone", memoryId: op.memoryId, status: "applied", note: row.text }
				: { op: "forget", id: op.memoryId, reason: "Undone", memoryId: op.memoryId, status: "skipped", note: "Already forgotten" };
		} else if (op.op === "update") {
			const [row] =
				op.previousText === undefined
					? []
					: yield* memoriesOf(sql`
						update memories set text = ${op.previousText}, updated_at = now()
						where ${where} and forgotten_at is null and text = ${op.text} returning *`);
			reversed = {
				op: "update", id: op.memoryId, text: op.previousText ?? "", quote: "", reason: "Undone", memoryId: op.memoryId,
				previousText: op.text, ...(row ? { status: "applied" as const } : { status: "skipped" as const, note: "Changed since" }),
			};
		} else {
			const [row] = yield* memoriesOf(sql`update memories set forgotten_at = null, updated_at = now() where ${where} and forgotten_at is not null returning *`);
			reversed = row
				? { op: "add", kind: row.kind, text: row.text, quote: "", reason: "Undone", memoryId: op.memoryId, status: "applied" }
				: { op: "add", kind: "fact", text: op.note ?? "", quote: "", reason: "Undone", memoryId: op.memoryId, status: "skipped", note: "Not found, or in use again" };
		}
		return reversed;
	});

	const findSaves = SqlSchema.findAll({
		Request: Schema.Struct({ owner: Schema.String, threadId: Schema.optional(Schema.String), limit: Schema.Number }),
		Result: SaveRow,
		execute: ({ owner, threadId, limit }) => {
			const thread = threadId ? sql`and thread_id = ${threadId}` : sql``;
			return sql`
				select * from memory_saves where owner = ${owner} ${thread}
				order by created_at desc limit ${limit}`;
		},
	});

	/** The person's save decisions, newest first; for one chat when given. */
	const list = Effect.fn("MemoryStore.saves")(function* (scope: MemoryScope, { threadId, limit = 50 }: { threadId?: string; limit?: number } = {}) {
		const rows = yield* findSaves({ owner: ownerOf(scope), threadId, limit }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return rows.map(
			(row): MemorySave => ({
				id: row.id,
				threadId: row.thread_id,
				messageId: row.message_id,
				summary: row.summary,
				operations: row.operations,
				model: row.model,
				ok: row.ok,
				error: row.error,
				ms: row.ms,
				createdAt: row.created_at.toISOString(),
				undoneAt: row.undone_at?.toISOString() ?? null,
				undoOf: row.undo_of,
			}),
		);
	});

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists memory_saves (
				id serial primary key,
				owner text not null,
				thread_id text,
				message_id text,
				summary text not null,
				operations jsonb not null default '[]',
				model text,
				ok boolean not null,
				error text,
				ms integer not null,
				created_at timestamptz not null default now(),
				undone_at timestamptz,
				undo_of integer
			)`;
		yield* sql`create index if not exists memory_saves_thread on memory_saves (thread_id, created_at)`;
		yield* sql`create index if not exists memory_saves_owner on memory_saves (owner, created_at desc)`;
	});

	return { write, edit, undo, list, migrate };
}
