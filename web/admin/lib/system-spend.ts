import type { SystemSpend } from "../api";

/**
 * The calls the app makes, not one person's reply (server/telemetry/Runs.ts,
 * SYSTEM_FUNCTION_IDS), in words for the overview's System lines. They cost no credits.
 */
const LINES = [
	{ functionId: "thread-title", label: "Chat names", what: "A name for each new chat" },
	{ functionId: "memory-embed", label: "Memory", what: "Embedding memories and memory searches" },
	{ functionId: "workspace-index", label: "Workspace documents", what: "Embedding the passages of each document" },
	{ functionId: "workspace-pdf", label: "Picture pages", what: "Pages of workspace PDFs that a model read" },
	{ functionId: "workspace-search", label: "Workspace search", what: "Embedding the question of each search" },
];

export type SystemLine = (typeof LINES)[number] & { usd: number | null; calls: number | null };

/** One line for each call, in a fixed order; null values while the numbers load. An id the page does not know yet gets its id as its name. */
export function systemLines(spend: SystemSpend | undefined): SystemLine[] {
	const known = LINES.map((line) => {
		const found = spend?.byFunction.find((row) => row.functionId === line.functionId);
		return { ...line, usd: spend ? (found?.usd ?? 0) : null, calls: spend ? (found?.calls ?? 0) : null };
	});
	const other = (spend?.byFunction ?? []).filter((row) => !LINES.some((line) => line.functionId === row.functionId));
	return [...known, ...other.map((row) => ({ functionId: row.functionId, label: row.functionId, what: "", usd: row.usd, calls: row.calls }))];
}
