import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { llmExtractor, quotedIn, type Decision, type ExistingMemory, type Extractor, type MemoryKind, type Operation } from "./extract.ts";
import { saveLog, type AppliedOperation } from "./save-log.ts";
import type { MemoryAdapter, MemoryFact, MemoryIndex, MemoryScope, MemoryTurn, RecallResult, SaveReceipt } from "./types.ts";

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

export type PostgresMemoryOptions = {
	sql: Sql;
	extract?: Extractor;
	index?: MemoryIndex;
	/** Up to this many memories, recall gives all of them. Defaults to 30. */
	recallAll?: number;
	/** Above that, how many recall finds. Defaults to 8. */
	topK?: number;
	/** Above `recallAll`, how many related memories the gate and writer see when saving. Defaults to 15. */
	saveContext?: number;
	/** How many forgotten memories the writer sees, newest first. Defaults to 20. */
	forgottenLimit?: number;
};

export type Row = {
	id: string;
	owner: string;
	kind: MemoryKind;
	text: string;
	reason: string | null;
	source_thread: string | null;
	source_message: string | null;
	created_at: Date;
	updated_at: Date;
	forgotten_at: Date | null;
};

export function postgresMemory({ sql, extract = llmExtractor, index, recallAll = 30, topK = 8, saveContext = 15, forgottenLimit = 20 }: PostgresMemoryOptions) {
	const ownerOf = (scope: MemoryScope) => scope.userId ?? "";
	const log = saveLog({ sql, ownerOf, reindex });

	/** The memories in use: the person's, not forgotten. */
	async function scoped(scope: MemoryScope) {
		return sql<Row[]>`select * from memories where owner = ${ownerOf(scope)} and forgotten_at is null order by updated_at desc`;
	}

	const adapter = {
		id: "postgres",
		name: index ? `Postgres + ${index.name ?? "search index"}` : "Postgres",

		async recall(scope, query): Promise<RecallResult> {
			const rows = await scoped(scope);
			if (!rows.length) return { systemPrompt: "", fragments: [] };
			const hits = rows.length <= recallAll ? rows : await search(scope, query, rows);
			return { systemPrompt: render(hits, rows.length), fragments: hits.map((row) => ({ text: row.text, source: row.id })) };
		},

		async save(scope, turn): Promise<SaveReceipt[]> {
			const startedAt = Date.now();
			const rows = await scoped(scope);
			let decision: Decision;
			try {
				// With many memories, the gate and writer see only the ones related to the turn, so a save costs the same at 30 memories or 3,000.
				const related = rows.length <= recallAll ? rows : await search(scope, turn.user, rows, saveContext);
				const existing: ExistingMemory[] = related.map((row) => ({ id: row.id, kind: row.kind, text: row.text }));
				decision = await extract({ scope, turn, existing, forgotten: await forgottenIn(scope) });
			} catch (error) {
				const message = (error as Error).message;
				await log.write(scope, turn, { summary: "Could not decide what to save", operations: [], model: null, ok: false, error: message, startedAt });
				return [{ ok: false, error: message, latencyMs: Date.now() - startedAt }];
			}

			const applied = await apply(scope, turn, decision.operations, new Set(rows.map((row) => row.id)));
			const indexError = await reindex(applied);
			await log.write(scope, turn, { summary: decision.summary, operations: applied, model: decision.model, ok: !indexError, error: indexError, startedAt });

			const done = applied.filter((op) => op.status === "applied");
			const latencyMs = Date.now() - startedAt;
			if (indexError) return [{ ok: false, error: `Saved, but the search index failed: ${indexError}`, latencyMs, raw: decision }];
			return done.length ? done.map((op) => ({ ok: true, latencyMs, raw: op })) : [{ ok: true, latencyMs, raw: { summary: decision.summary } }];
		},

		async inspect(scope) {
			return { takenAt: new Date().toISOString(), data: { memories: (await scoped(scope)).map(toStored) } };
		},

		async listFacts(scope): Promise<MemoryFact[]> {
			return (await scoped(scope)).map((row) => ({ id: row.id, text: row.text, source: row.kind, createdAt: row.created_at.toISOString() }));
		},

		async update(scope, id, text) {
			const [row] = await sql<(Row & { previous: string })[]>`
				update memories m set text = ${text}, updated_at = now()
				from (select id, text as previous from memories where id = ${id} for update) old
				where m.id = old.id and m.owner = ${ownerOf(scope)} and m.forgotten_at is null
				returning m.*, old.previous`;
			if (!row) return false;
			await index?.upsert([toIndexed(row)]).catch(logIndexError);
			await log.edit(scope, "Edited on the Memory page", {
				op: "update", id, text, quote: "", reason: "Edited by the person", memoryId: id, status: "applied", previousText: row.previous,
			});
			return true;
		},

		async forget(scope, id) {
			const [row] = await sql<Row[]>`
				update memories set forgotten_at = now() where id = ${id} and owner = ${ownerOf(scope)} and forgotten_at is null returning *`;
			if (!row) return false;
			await index?.remove([id]).catch(logIndexError);
			await log.edit(scope, "Forgotten on the Memory page", { op: "forget", id, reason: "Forgotten by the person", memoryId: id, status: "applied", note: row.text });
			return true;
		},
	} satisfies MemoryAdapter;

	async function forgottenIn(scope: MemoryScope) {
		const rows = await sql<{ text: string }[]>`
			select text from memories where owner = ${ownerOf(scope)} and forgotten_at is not null order by forgotten_at desc limit ${forgottenLimit}`;
		return rows.map((row) => row.text);
	}

	async function search(scope: MemoryScope, query: string, rows: Row[], limit = topK): Promise<Row[]> {
		const byId = new Map(rows.map((row) => [row.id, row]));
		if (index) {
			try {
				const found = (await index.search(ownerOf(scope), query, limit)).map((id) => byId.get(id)).filter((row): row is Row => !!row);
				if (found.length) return found;
			} catch (error) {
				console.error("memory: index search failed, using Postgres:", (error as Error).message);
			}
		}
		const found = await sql<{ id: string }[]>`
			select id from memories
			where owner = ${ownerOf(scope)} and forgotten_at is null and to_tsvector('simple', text) @@ websearch_to_tsquery('simple', ${query})
			order by ts_rank(to_tsvector('simple', text), websearch_to_tsquery('simple', ${query})) desc, updated_at desc
			limit ${limit}`;
		const hits = found.map(({ id }) => byId.get(id)).filter((row): row is Row => !!row);
		return hits.length ? hits : rows.slice(0, limit);
	}

	/** Applies the extractor's operations in one transaction, skipping any that name a memory outside the scope. */
	async function apply(scope: MemoryScope, turn: MemoryTurn, operations: Operation[], known: Set<string>): Promise<AppliedOperation[]> {
		return sql.begin(async (tx) => {
			const results: AppliedOperation[] = [];
			for (const op of operations) {
				if (op.op !== "forget" && !quotedIn(turn.user, op.quote)) {
					results.push({ ...op, memoryId: op.op === "update" ? op.id : "", status: "skipped", note: "The quote is not in what the person said" });
				} else if (op.op === "add") {
					const id = randomUUID();
					await tx`
						insert into memories (id, owner, kind, text, reason, source_thread, source_message)
						values (${id}, ${ownerOf(scope)}, ${op.kind}, ${op.text}, ${op.reason}, ${scope.threadId}, ${turn.messageId ?? null})`;
					results.push({ ...op, memoryId: id, status: "applied" });
				} else if (!known.has(op.id)) {
					results.push({ ...op, memoryId: op.id, status: "skipped", note: "No such memory in this scope" });
				} else if (op.op === "update") {
					const [old] = await tx<{ text: string }[]>`select text from memories where id = ${op.id} for update`;
					await tx`
						update memories set text = ${op.text}, reason = ${op.reason}, source_thread = ${scope.threadId},
							source_message = ${turn.messageId ?? null}, updated_at = now()
						where id = ${op.id}`;
					results.push({ ...op, memoryId: op.id, status: "applied", previousText: old.text });
				} else {
					const [gone] = await tx<{ text: string }[]>`update memories set forgotten_at = now() where id = ${op.id} returning text`;
					results.push({ ...op, memoryId: op.id, status: "applied", note: gone?.text });
				}
			}
			return results;
		});
	}

	/** Brings the index up to date with applied operations. Returns the error, if any; the memories are saved either way. */
	async function reindex(applied: AppliedOperation[]) {
		if (!index) return null;
		const done = applied.filter((op) => op.status === "applied");
		try {
			const changed = done.filter((op) => op.op !== "forget").map((op) => op.memoryId);
			if (changed.length) {
				const rows = await sql<Row[]>`select * from memories where id = any(${changed})`;
				await index.upsert(rows.map(toIndexed));
			}
			await index.remove(done.filter((op) => op.op === "forget").map((op) => op.memoryId));
			return null;
		} catch (error) {
			logIndexError(error);
			return (error as Error).message;
		}
	}

	return {
		...adapter,
		undo: log.undo,
		saves: log.list,

		async migrate() {
			await sql`
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
			await sql`create index if not exists memories_owner on memories (owner, updated_at desc)`;
			await log.migrate();
		},

		/** Rebuilds the index from Postgres when the two disagree. */
		async syncIndex() {
			if (!index) return;
			const rows = await sql<Row[]>`select * from memories where forgotten_at is null`;
			if ((await index.count()) === rows.length) return;
			await index.rebuild(rows.map(toIndexed));
			console.log(`memory: rebuilt the search index with ${rows.length} memories`);
		},

		/** The person's memories, for the Memory page. */
		async list(scope: MemoryScope): Promise<StoredMemory[]> {
			return (await scoped(scope)).map(toStored);
		},
	};
}

export type PostgresMemory = ReturnType<typeof postgresMemory>;

/**
 * The block for the system prompt. Each memory's text is JSON-quoted, as TanStack's
 * renderer does, so a saved sentence cannot break out of the list and pose as instructions.
 */
export function render(hits: Pick<Row, "kind" | "text">[], total: number) {
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

function toIndexed(row: Row) {
	return { id: row.id, owner: row.owner, text: row.text };
}

function logIndexError(error: unknown) {
	console.error("memory: search index update failed:", (error as Error).message);
}
