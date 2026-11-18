import { onBeforeUnmount, watch, type Ref } from "vue";
import { isRecord } from "./json";

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

/** Fills `text` with the thread's draft and keeps the draft in step with it. Call from a chat's setup. */
export function useDraft(threadId: string, text: Ref<string>) {
	text.value = read()[threadId]?.text ?? text.value;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		clearTimeout(timer);
		timer = undefined;
		save(threadId, text.value);
	};

	watch(text, () => {
		clearTimeout(timer);
		timer = setTimeout(flush, SAVE_AFTER_MS);
	});
	window.addEventListener("pagehide", flush);
	// Always saved as the box goes, not only with a save pending: sending clears the field just
	// before a workspace page leaves for the new chat, and the page goes before its watch runs.
	onBeforeUnmount(() => {
		window.removeEventListener("pagehide", flush);
		flush();
	});
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
		return draftsIn(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
	} catch {
		return {};
	}
}

/** The drafts kept on this device, possibly by an older version: an entry of another shape is dropped. */
function draftsIn(value: unknown): Drafts {
	if (!isRecord(value)) return {};
	const drafts: Drafts = {};
	for (const [threadId, draft] of Object.entries(value)) {
		if (isRecord(draft) && typeof draft.text === "string" && typeof draft.savedAt === "number") drafts[threadId] = { text: draft.text, savedAt: draft.savedAt };
	}
	return drafts;
}
