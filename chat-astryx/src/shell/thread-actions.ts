import type { ThreadSummary } from "../lib/threads";
import { createStore } from "../lib/store";

/**
 * Extra rows for each thread's menu in the list, between Rename and Delete. A feature
 * module adds its own here (Export as Markdown), so the list does not import it.
 */
export type ThreadAction = { label: string; run: (thread: ThreadSummary) => void };

export const threadActions = createStore<ThreadAction[]>([]);

export function addThreadAction(action: ThreadAction) {
	threadActions.set((list) => [...list.filter((each) => each.label !== action.label), action]);
}
