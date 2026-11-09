import { ref } from "vue";
import { fetchThreadSaves, undoSave, type MemoryOperation, type MemorySave } from "./memory";

export type Remembered = { save: MemorySave; operations: MemoryOperation[] };

export const MEMORY_LABELS = { add: "Remembered", update: "Updated memory", forget: "Forgot" } as const;

/**
 * The notes under a chat's replies: what each reply added to memory, by message id, one
 * entry per save so each can be undone. Memory saves after the reply, so the chat loads
 * again with `wait` once a reply finishes, and the server waits for the save.
 */
export function useRememberedNotes(threadId: string) {
	const byMessage = ref(new Map<string, Remembered[]>());
	/** Saves that arrived after the first load (a reply just finished): only these animate in. */
	const fresh = ref(new Set<number>());
	const shown = new Set<number>();
	let loaded = false;

	async function load({ wait = false } = {}) {
		const notes = notesByMessage(await fetchThreadSaves(threadId, { wait }));
		const ids = [...notes.values()].flat().map(({ save }) => save.id);
		fresh.value = new Set(loaded ? ids.filter((id) => !shown.has(id)) : []);
		for (const id of ids) shown.add(id);
		loaded = true;
		byMessage.value = notes;
	}

	async function undo(save: MemorySave) {
		try {
			await undoSave(save.id);
		} finally {
			await load();
		}
	}

	return { byMessage, fresh, load, undo };
}

/** The saves that changed something, by the message they came from, oldest first. */
function notesByMessage(saves: MemorySave[]) {
	const notes = new Map<string, Remembered[]>();
	for (const save of [...saves].reverse()) {
		if (!save.messageId) continue;
		const operations = save.operations.filter((op) => op.status === "applied");
		if (operations.length) notes.set(save.messageId, [...(notes.get(save.messageId) ?? []), { save, operations }]);
	}
	return notes;
}
