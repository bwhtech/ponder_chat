/** The memory API: what Ponder remembers about the person, the decisions behind it, and the prompt that makes them. */
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
	const response = await fetch("/api/memory");
	if (!response.ok) throw new Error("Memory could not be loaded.");
	return response.json();
}

/** A thread's save decisions. With `wait`, the server first waits for a save still running. */
export async function fetchThreadSaves(threadId: string, { wait = false } = {}): Promise<MemorySave[]> {
	const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/memory${wait ? "?wait=1" : ""}`);
	return response.ok ? (await response.json()).saves : [];
}

export async function updateMemory(id: string, text: string) {
	const response = await fetch(`/api/memory/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
	if (!response.ok) throw new Error("The memory could not be changed.");
}

export async function forgetMemory(id: string) {
	const response = await fetch(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!response.ok) throw new Error("The memory could not be forgotten.");
}

/** Reverses a save: what it remembered is forgotten, what it changed or forgot comes back. */
export async function undoSave(id: number) {
	const response = await fetch(`/api/memory/saves/${id}/undo`, { method: "POST" });
	if (!response.ok) throw new Error("This could not be undone.");
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
