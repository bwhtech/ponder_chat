import type * as Effect from "effect/Effect";

/**
 * The memory contract, ported from TanStack AI's `@tanstack/ai-memory` 1.0.0 (MIT, see LICENSE-tanstack-ai;
 * src/types.ts), by way of the Seva platform. A backend implements two verbs: `recall`
 * ("what is relevant to this query?") and `save` ("remember this turn"). The chat
 * workflow calls `recall` before the model runs and `save` after the reply is saved.
 * Adapters own everything else: extraction, ranking, rendering, scope isolation, expiry.
 *
 * Differences from TanStack, kept small so a TanStack adapter ports with little change:
 * - `RecallResult.tools` is left out: Ponder's memory offers the model no tools.
 * - `MemoryTurn.messageId` is new and optional: the reply that produced the turn, for provenance.
 * - `update` and `forget` are new optional methods, for the Memory page.
 * - Each method returns an Effect, not a Promise (docs/effect.md), with the adapter's own
 *   failures in its type. A TanStack adapter ports by wrapping its calls in Effect.tryPromise.
 */

/**
 * Who the memory belongs to. Resolve every field on the server from trusted state;
 * never take `userId` from the request body. Ponder has no organisations, so it never
 * sets `tenantId`, and its adapter keys memories by `userId` alone.
 */
export type MemoryScope = {
	/** The conversation. Required: the smallest isolation key. */
	threadId: string;
	/** The person, for cross-thread recall and per-user isolation. */
	userId?: string;
	/** The organisation. Not used in Ponder. */
	tenantId?: string;
	/** Reserved. Adapters that do not use it must ignore it. */
	namespace?: string;
};

/** A finished turn, handed to `save`. */
export type MemoryTurn = {
	user: string;
	assistant: string;
	/** The id of the reply this turn ended with. */
	messageId?: string;
};

/** One recalled item, when the adapter produces them. */
export type MemoryFragment = {
	text: string;
	/** Where it came from: a record id or a vendor result type. */
	source: string;
};

/** What the run gets from `recall`. */
export type RecallResult = {
	/** A block for the system prompt. Empty means nothing to add. */
	systemPrompt: string;
	fragments?: MemoryFragment[];
	/** The raw vendor payload, for inspection. */
	raw?: unknown;
};

/** One write that `save` made. A turn can produce several. */
export type SaveReceipt = {
	ok: boolean;
	latencyMs?: number;
	/** Set when `ok` is false. */
	error?: string;
	raw?: unknown;
};

/** The full state, from the optional `inspect`. */
export type MemorySnapshot = {
	/** ISO time the snapshot was taken. */
	takenAt: string;
	data: unknown;
};

/** One stored fact, from the optional `listFacts`. */
export type MemoryFact = {
	id: string;
	text: string;
	source?: string;
	/** ISO time, when the adapter tracks it. */
	createdAt?: string;
};

export interface MemoryAdapter<E = never> {
	/** A stable id for logs, e.g. "postgres". */
	readonly id: string;
	readonly name?: string;

	/** Read: what is relevant to `query` within `scope`. How it ranks is the adapter's business. */
	readonly recall: (scope: MemoryScope, query: string) => Effect.Effect<RecallResult, E>;
	/** Write: keep a finished turn. Extraction (turn → stored facts) happens here. */
	readonly save: (scope: MemoryScope, turn: MemoryTurn) => Effect.Effect<SaveReceipt[], E>;

	readonly inspect?: (scope: MemoryScope) => Effect.Effect<MemorySnapshot, E>;
	readonly listFacts?: (scope: MemoryScope) => Effect.Effect<MemoryFact[], E>;

	/** Change a stored fact's text. False when it is not in this scope. */
	readonly update?: (scope: MemoryScope, id: string, text: string) => Effect.Effect<boolean, E>;
	/** Forget a stored fact. False when it is not in this scope. */
	readonly forget?: (scope: MemoryScope, id: string) => Effect.Effect<boolean, E>;
}

/** What the search index holds for one memory: never more than this. */
export type IndexedMemory = { id: string; owner: string; text: string };

/** One row of the index: the text it was embedded from, and whether the current embedding model made it. */
export type IndexEntry = { id: string; text: string; current: boolean };

/** A search index over the memories in use. Postgres stays the source of truth; the index is repaired from it. */
export interface MemoryIndex<E = never> {
	readonly name?: string;
	readonly upsert: (memories: IndexedMemory[]) => Effect.Effect<void, E>;
	readonly remove: (ids: string[]) => Effect.Effect<void, E>;
	/** The ids of the person's memories that best match `query`, best first. */
	readonly search: (owner: string, query: string, limit: number) => Effect.Effect<string[], E>;
	/** Every row, without its vector: the store compares them with `memories`. */
	readonly entries: Effect.Effect<ReadonlyArray<IndexEntry>, E>;
}
