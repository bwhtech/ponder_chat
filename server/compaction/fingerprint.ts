import { createHash } from "node:crypto";
import type { UIMessage } from "ai";

/**
 * What a summary was written from: each message's id, role and text, for every message
 * the summarizer read. A change to any of them (an edit, a deleted or reordered message)
 * makes the summary stale. The rest of a message is left out on purpose: the browser
 * sends its own copies of old messages with each new one, and their metadata can differ
 * from the server's copies.
 */
export function fingerprint(messages: UIMessage[]) {
	const hash = createHash("sha256");
	for (const message of messages) {
		const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		hash.update(JSON.stringify([message.id, message.role, text]));
	}
	return hash.digest("hex");
}

/** A saved summary still stands for the thread: the messages it read are all there, unchanged. */
export function isCurrent(thread: UIMessage[], saved: { reads: number; fingerprint: string }) {
	return saved.reads <= thread.length && fingerprint(thread.slice(0, saved.reads)) === saved.fingerprint;
}
