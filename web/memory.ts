import { client, unwrap } from "./api";

/**
 * The memory API: what Ponder remembers about the person, the decisions behind it, and the
 * prompt that makes them. These shapes are flatter than the server's (an operation's fields
 * there depend on its kind), so they stay here; the return types below check that the
 * server's answers fit them.
 */
export type Memory = {
	id: string;
	kind: "fact" | "project" | "preference";
	text: string;
	reason: string | null;
	sourceThread: string | null;
	sourceMessage: string | null;
	createdAt: string;
	updatedAt: string;
};

export type MemoryOperation = {
	op: "add" | "update" | "forget";
	memoryId: string;
	text?: string;
	reason: string;
	status: "applied" | "skipped";
	/** For a forget: the text that was forgotten. For a skipped operation: why. */
	note?: string;
	/** For an update: the text it replaced. */
	previousText?: string;
};

export type MemorySave = {
	id: number;
	threadId: string | null;
	messageId: string | null;
	summary: string;
	operations: MemoryOperation[];
	model: string | null;
	ok: boolean;
	error: string | null;
	createdAt: string;
	/** When the person undid this save. */
	undoneAt: string | null;
	/** For an undo: the save it undid. */
	undoOf: number | null;
};

export type MemoryOverview = { enabled: boolean; adapter: string; memories: Memory[]; saves: MemorySave[]; prompt: string };

export async function fetchMemory(): Promise<MemoryOverview> {
	return unwrap(client.api.memory.$get(), "Memory could not be loaded.");
}

/** A thread's save decisions. With `wait`, the server first waits for a save still running. */
export async function fetchThreadSaves(threadId: string, { wait = false } = {}): Promise<MemorySave[]> {
	// The notes under the replies are extra: without them the chat still works.
	const saves = client.api.threads[":id"].memory.$get({ param: { id: encodeURIComponent(threadId) }, query: { wait: wait ? "1" : undefined } });
	return (await unwrap(saves).catch(() => ({ saves: [] }))).saves;
}

export async function updateMemory(id: string, text: string) {
	await unwrap(client.api.memory[":id"].$patch({ param: { id: encodeURIComponent(id) }, json: { text } }), "The memory could not be changed.");
}

export async function forgetMemory(id: string) {
	await unwrap(client.api.memory[":id"].$delete({ param: { id: encodeURIComponent(id) } }), "The memory could not be forgotten.");
}

/** Reverses a save: what it remembered is forgotten, what it changed or forgot comes back. */
export async function undoSave(id: number) {
	await unwrap(client.api.memory.saves[":id"].undo.$post({ param: { id: String(id) } }), "This could not be undone.");
}

/** Whether a save changed anything that can still be undone. */
export function canUndo(save: MemorySave) {
	return !save.undoneAt && !save.undoOf && save.operations.some((op) => op.status === "applied");
}

export const KIND_LABELS: Record<Memory["kind"], string> = {
	fact: "About you",
	project: "Project",
	preference: "Preference",
};
