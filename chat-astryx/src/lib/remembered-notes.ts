import { useCallback, useRef, useState } from "react";
import { fetchThreadSaves, undoSave, type MemoryOperation, type MemorySave } from "./memory";

export type Remembered = { save: MemorySave; operations: MemoryOperation[] };

export const MEMORY_LABELS = { add: "Remembered", update: "Updated memory", forget: "Forgot" } as const;

/**
 * The notes under a chat's replies: what each reply added to memory, by message id, one
 * entry per save so each can be undone. Memory saves after the reply, so the chat loads
 * again with `wait` once a reply finishes, and the server waits for the save.
 */
export function useRememberedNotes(threadId: string) {
	const [byMessage, setByMessage] = useState(() => new Map<string, Remembered[]>());
	/** Saves that arrived after the first load (a reply just finished): only these animate in. */
	const [fresh, setFresh] = useState(() => new Set<number>());
	const shown = useRef(new Set<number>());
	const loaded = useRef(false);

	const load = useCallback(
		async ({ wait = false } = {}) => {
			const notes = notesByMessage(await fetchThreadSaves(threadId, { wait }));
			const ids = [...notes.values()].flat().map(({ save }) => save.id);
			setFresh(new Set(loaded.current ? ids.filter((id) => !shown.current.has(id)) : []));
			for (const id of ids) shown.current.add(id);
			loaded.current = true;
			setByMessage(notes);
		},
		[threadId],
	);

	const undo = useCallback(
		async (save: MemorySave) => {
			try {
				await undoSave(save.id);
			} finally {
				await load();
			}
		},
		[load],
	);

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
