import { ref, watch, type Ref } from "vue";
import { client, unwrap, type Answer } from "./api";

/**
 * Search in the person's chats (GET /api/threads/search). Asks a moment after the person
 * stops typing, and drops answers to older questions that arrive late.
 */
export type ThreadHit = Answer<typeof client.api.threads.search.$get>["threads"][number];

/** The server marks matched words with these (server/thread-search.ts). */
const MATCH = /(.*?)/g;

export function useThreadSearch(query: Ref<string>) {
	const hits = ref<ThreadHit[]>([]);
	const searching = ref(false);
	const failed = ref(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let asked = 0;

	watch(query, (text) => {
		clearTimeout(timer);
		// A new question: the last one's failure no longer applies.
		failed.value = false;
		if (!text.trim()) {
			asked++;
			hits.value = [];
			searching.value = false;
			return;
		}
		searching.value = true;
		timer = setTimeout(() => void ask(text), 200);
	});

	async function ask(text: string) {
		const mine = ++asked;
		try {
			const { threads } = await unwrap(client.api.threads.search.$get({ query: { q: text } }));
			if (mine !== asked) return;
			hits.value = threads;
			failed.value = false;
		} catch {
			if (mine === asked) failed.value = true;
		} finally {
			if (mine === asked) searching.value = false;
		}
	}

	return { hits, searching, failed };
}

/** An excerpt as pieces, with the matched words flagged, for the template to bold. Never HTML. */
export function excerptPieces(excerpt: string) {
	const pieces: { text: string; match: boolean }[] = [];
	let last = 0;
	for (const found of excerpt.matchAll(MATCH)) {
		if (found.index > last) pieces.push({ text: excerpt.slice(last, found.index), match: false });
		pieces.push({ text: found[1], match: true });
		last = found.index + found[0].length;
	}
	if (last < excerpt.length) pieces.push({ text: excerpt.slice(last), match: false });
	return pieces;
}
