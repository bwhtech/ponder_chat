import { useEffect, useRef, useState } from "react";

/**
 * Search in the person's chats (GET /api/threads/search). Asks a moment after the person
 * stops typing, and drops answers to older questions that arrive late.
 */
export type ThreadHit = { id: string; title: string; updatedAt: string; excerpt: string };

/** The server marks matched words with these (server/thread-search.ts). */
const MATCH = /(.*?)/g;

export function useThreadSearch(query: string) {
	const [hits, setHits] = useState<ThreadHit[]>([]);
	const [searching, setSearching] = useState(false);
	const [failed, setFailed] = useState(false);
	const asked = useRef(0);

	useEffect(() => {
		// A new question: the last one's failure no longer applies.
		setFailed(false);
		const mine = ++asked.current;
		if (!query.trim()) {
			setHits([]);
			setSearching(false);
			return;
		}
		setSearching(true);
		const timer = setTimeout(async () => {
			try {
				const response = await fetch(`/api/threads/search?q=${encodeURIComponent(query)}`);
				if (!response.ok) throw new Error(String(response.status));
				const { threads } = (await response.json()) as { threads: ThreadHit[] };
				if (mine !== asked.current) return;
				setHits(threads);
				setFailed(false);
			} catch {
				if (mine === asked.current) setFailed(true);
			} finally {
				if (mine === asked.current) setSearching(false);
			}
		}, 200);
		return () => clearTimeout(timer);
	}, [query]);

	return { hits, searching, failed };
}

/** An excerpt as pieces, with the matched words flagged, for the list to bold. Never HTML. */
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
