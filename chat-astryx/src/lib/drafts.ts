import { useEffect, useRef, useState } from "react";

/**
 * What the person was writing, per thread, so switching threads, a reload or a closed
 * tab does not lose it. Kept in localStorage, saved 300 ms after the last keystroke and
 * at once when the chat closes or the page unloads. Sending clears the field, and so the
 * draft. Only the text: attached files are not kept. Adapted from T3 Code's composer drafts.
 */
const KEY = "ponder-chat:drafts:v1";
const SAVE_AFTER_MS = 300;
/** The most drafts kept; the oldest go first. */
const MAX_DRAFTS = 50;

type Drafts = Record<string, { text: string; savedAt: number }>;

/** The field's text for a chat, starting from the thread's draft and kept in step with it. */
export function useDraft(threadId: string) {
	const [text, setText] = useState(() => read()[threadId]?.text ?? "");
	const latest = useRef(text);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		if (latest.current === text) return;
		latest.current = text;
		clearTimeout(timer.current);
		timer.current = setTimeout(flush, SAVE_AFTER_MS);
	});

	function flush() {
		clearTimeout(timer.current);
		timer.current = undefined;
		save(threadId, latest.current);
	}

	useEffect(() => {
		const onHide = () => flush();
		addEventListener("pagehide", onHide);
		return () => {
			removeEventListener("pagehide", onHide);
			if (timer.current) flush();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [threadId]);

	return [text, setText] as const;
}

function save(threadId: string, text: string) {
	const drafts = read();
	if (text.trim()) drafts[threadId] = { text, savedAt: Date.now() };
	else delete drafts[threadId];
	const kept = Object.entries(drafts)
		.sort(([, a], [, b]) => b.savedAt - a.savedAt)
		.slice(0, MAX_DRAFTS);
	try {
		localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
	} catch {
		// Storage full or blocked: the draft lives only in the page.
	}
}

function read(): Drafts {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Drafts;
	} catch {
		return {};
	}
}
