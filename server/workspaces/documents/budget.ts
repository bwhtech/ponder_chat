/**
 * Which ready documents go whole into a turn, and which are searched (docs/workspaces-plan.md,
 * "Documents: what Ponder does", step 4). Flow's rule for attachments: when all the text
 * fits in half of the model's context window, at 4 characters for each token, all of it
 * goes in; otherwise the largest documents move to search until the rest fit. The limit
 * on file text in one call (file-context.ts) applies too. Pure, so the edge is tested.
 */
export const CHARS_PER_TOKEN = 4;
/** File text in one call, as for chat attachments (file-context.ts). */
export const MAX_INLINE_CHARS = 300_000;
/** A model whose window OpenRouter does not give is taken as this size. */
const UNKNOWN_WINDOW = 128_000;

export function inlineBudget(window: number | null) {
	return Math.min(MAX_INLINE_CHARS, Math.floor(((window ?? UNKNOWN_WINDOW) / 2) * CHARS_PER_TOKEN));
}

export type Sized = { id: string; chars: number };

/** The documents to put in whole, in their order, and the ones to search, largest first. */
export function chooseInline<T extends Sized>(documents: ReadonlyArray<T>, budget: number): { inline: T[]; search: T[] } {
	let total = documents.reduce((sum, document) => sum + document.chars, 0);
	const search: T[] = [];
	for (const document of [...documents].sort((a, b) => b.chars - a.chars || a.id.localeCompare(b.id))) {
		if (total <= budget) break;
		search.push(document);
		total -= document.chars;
	}
	return { inline: documents.filter((document) => !search.includes(document)), search };
}
