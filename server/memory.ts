import type { UIMessage } from "ai";
import { sql } from "./db.ts";
import { memoryMiddleware, type MemoryContext } from "./memory/middleware.ts";
import { pgvectorIndex } from "./memory/pgvector-index.ts";
import { postgresMemory } from "./memory/postgres.ts";

import { readExtractPrompt } from "./memory/extract.ts";

/**
 * Memory across chats: what the person told Ponder about themselves before. Ported from
 * the Seva platform, whose contract and middleware follow TanStack AI's (memory/types.ts,
 * memory/middleware.ts). Memories are in Postgres with a pgvector search index
 * (PONDER_MEMORY_INDEX=off leaves it out); memory/gate.json and memory/extract.md decide
 * what each turn adds. PONDER_MEMORY=off turns memory off. See docs/memory.md.
 */
const memoryEnabled = process.env.PONDER_MEMORY !== "off";

const memoryStore = postgresMemory({ sql, index: process.env.PONDER_MEMORY_INDEX === "off" ? undefined : pgvectorIndex({ sql }) });

/** The scope of a request: the signed-in person. Memory is not kept per chat. */
const memoryScope = ({ threadId, user }: MemoryContext) => ({ threadId, userId: user });

const memory = memoryMiddleware({ adapter: memoryStore, scope: memoryScope });

/**
 * How memory works, for the model, on every run while memory is on. It must match what
 * gate.json and extract.md keep out, so the model never promises to remember what the
 * writer will refuse.
 */
const MEMORY_GUIDANCE = `You have a memory across conversations. It saves itself after each reply: you do not call a tool for it.
When the person asks you to remember or forget something, say you will. But memory never keeps passwords, keys or tokens, phone numbers, email addresses, home addresses, ID, bank or card numbers (theirs or anyone's), health details, or personal details about other people. If they ask you to remember one of those, say you cannot keep it in memory.`;

/**
 * What memory adds to a run, both empty when memory is off. The guidance never changes,
 * so it goes in the instructions. What was recalled for the person's latest message
 * changes each time, so it goes with that message (workflow/context.ts).
 */
export async function memoryForRun(ctx: MemoryContext, messages: UIMessage[]) {
	if (!memoryEnabled) return { guidance: "", recalled: "" };
	return { guidance: MEMORY_GUIDANCE, recalled: await memory.recall(ctx, messages) };
}

/** Saves the turn that ends the thread, in the background. */
export function rememberTurn(ctx: MemoryContext, messages: UIMessage[]) {
	if (memoryEnabled) memory.save(ctx, messages);
}

/**
 * What one person can see and change in their memory: the Memory page, and the notes
 * under each reply. Every call touches only their memories and decisions.
 */
export function memoryFor(user: string) {
	const scope = (threadId = "") => memoryScope({ threadId, user });
	return {
		/** The Memory page: whether memory is on, the memories, the latest decisions, and the prompt that makes them. */
		async overview() {
			const [memories, saves, prompt] = await Promise.all([memoryStore.list(scope()), memoryStore.saves(scope(), { limit: 30 }), readExtractPrompt()]);
			return { enabled: memoryEnabled, adapter: memoryStore.name, memories, saves, prompt };
		},
		/** False when the memory is not theirs. */
		update: (id: string, text: string) => memoryStore.update(scope(), id, text),
		forget: (id: string) => memoryStore.forget(scope(), id),
		/** The operations it reversed, or null when the save is not theirs or was undone already. */
		undo: (saveId: number) => memoryStore.undo(scope(), saveId),
		/** One chat's decisions. With `settle`, first waits for its save still running. */
		async threadSaves(threadId: string, { settle = false } = {}) {
			if (settle) await memory.settled(threadId);
			return memoryStore.saves(scope(threadId), { threadId });
		},
	};
}

export async function setupMemory() {
	await memoryStore.migrate();
	// The index is rebuilt from Postgres when it is missing or out of step; a failure leaves search to Postgres.
	memoryStore.syncIndex().catch((error) => console.error("memory: could not sync the search index:", error.message));
}
