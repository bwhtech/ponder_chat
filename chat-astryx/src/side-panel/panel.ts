import { createStore } from "../lib/store";

/** What the side panel shows: a file or an artifact of the open chat. Stub until it is ported. */
export type PanelContent = { kind: string; [key: string]: unknown };

export const panel = createStore<PanelContent | null>(null);

export function closePanel() {
	panel.set(null);
}
