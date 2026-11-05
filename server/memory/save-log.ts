import type { Sql } from "postgres";
import type { Operation } from "./extract.ts";
import type { Row } from "./postgres.ts";
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

type SaveLogOptions = {
	sql: Sql;
	ownerOf: (scope: MemoryScope) => string;
	/** Brings the search index up to date after an undo; returns its error, if any. */
	reindex: (applied: AppliedOperation[]) => Promise<string | null>;
};

export function saveLog({ sql, ownerOf, reindex }: SaveLogOptions) {
	async function write(scope: MemoryScope, turn: Partial<MemoryTurn>, entry: Entry) {
		await sql`
			insert into memory_saves (owner, thread_id, message_id, summary, operations, model, ok, error, ms, undo_of)
			values (${ownerOf(scope)}, ${scope.threadId || null}, ${turn.messageId ?? null}, ${entry.summary},
				${sql.json(entry.operations as never)}, ${entry.model}, ${entry.ok}, ${entry.error}, ${Date.now() - entry.startedAt}, ${entry.undoOf ?? null})`;
	}

	function edit(scope: MemoryScope, summary: string, operation: AppliedOperation) {
		return write(scope, {}, { summary, operations: [operation], model: null, ok: true, error: null, startedAt: Date.now() });
	}

	/**
	 * Reverses one of the person's saves, newest change first: an add is forgotten, an update
	 * gets its old text back, a forgotten memory comes back. A memory that changed since is
	 * left as it is. The undo is logged as a save of its own. Returns null when there is no
	 * such save in the scope, or it was undone already.
	 */
	async function undo(scope: MemoryScope, saveId: number): Promise<AppliedOperation[] | null> {
		const startedAt = Date.now();
		const result = await sql.begin(async (tx) => {
			const [save] = await tx<{ thread_id: string | null; summary: string; operations: AppliedOperation[] }[]>`
				update memory_saves set undone_at = now()
				where id = ${saveId} and owner = ${ownerOf(scope)} and undone_at is null and undo_of is null
				returning thread_id, summary, operations`;
			if (!save) return null;
			const reversed: AppliedOperation[] = [];
			for (const op of save.operations.filter((o) => o.status === "applied").reverse()) {
				reversed.push(await reverse(tx as unknown as Sql, ownerOf(scope), op));
			}
			return { save, reversed };
		});
		if (!result) return null;
		const indexError = await reindex(result.reversed);
		await write({ ...scope, threadId: result.save.thread_id ?? "" }, {}, {
			summary: `Undid: ${result.save.summary}`, operations: result.reversed, model: null, ok: !indexError, error: indexError, startedAt, undoOf: saveId,
		});
		return result.reversed;
	}

	/** The person's save decisions, newest first; for one chat when given. */
	async function list(scope: MemoryScope, { threadId, limit = 50 }: { threadId?: string; limit?: number } = {}): Promise<MemorySave[]> {
		const thread = threadId ? sql`and thread_id = ${threadId}` : sql``;
		const rows = await sql`
			select * from memory_saves where owner = ${ownerOf(scope)} ${thread}
			order by created_at desc limit ${limit}`;
		return rows.map((row) => ({
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
		}));
	}

	async function migrate() {
		await sql`
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
		await sql`create index if not exists memory_saves_thread on memory_saves (thread_id, created_at)`;
		await sql`create index if not exists memory_saves_owner on memory_saves (owner, created_at desc)`;
	}

	return { write, edit, undo, list, migrate };
}

/** Reverses one applied operation inside the undo's transaction. */
async function reverse(tx: Sql, owner: string, op: AppliedOperation): Promise<AppliedOperation> {
	const where = tx`id = ${op.memoryId} and owner = ${owner}`;
	if (op.op === "add") {
		const [row] = await tx<Row[]>`update memories set forgotten_at = now() where ${where} and forgotten_at is null returning *`;
		return row
			? { op: "forget", id: op.memoryId, reason: "Undone", memoryId: op.memoryId, status: "applied", note: row.text }
			: { op: "forget", id: op.memoryId, reason: "Undone", memoryId: op.memoryId, status: "skipped", note: "Already forgotten" };
	}
	if (op.op === "update") {
		const [row] = op.previousText === undefined ? [] : await tx<Row[]>`
			update memories set text = ${op.previousText}, updated_at = now()
			where ${where} and forgotten_at is null and text = ${op.text} returning *`;
		return {
			op: "update", id: op.memoryId, text: op.previousText ?? "", quote: "", reason: "Undone", memoryId: op.memoryId,
			previousText: op.text, ...(row ? { status: "applied" as const } : { status: "skipped" as const, note: "Changed since" }),
		};
	}
	const [row] = await tx<Row[]>`update memories set forgotten_at = null, updated_at = now() where ${where} and forgotten_at is not null returning *`;
	return row
		? { op: "add", kind: row.kind, text: row.text, quote: "", reason: "Undone", memoryId: op.memoryId, status: "applied" }
		: { op: "add", kind: "fact", text: op.note ?? "", quote: "", reason: "Undone", memoryId: op.memoryId, status: "skipped", note: "Not found, or in use again" };
}
