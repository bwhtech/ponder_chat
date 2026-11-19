import type { WebChoice } from "../../shared/web-mode";

/**
 * A question asked on a workspace page (WorkspacePage.vue). The page starts a new chat, and
 * the chat (ChatView.vue) takes the question as its first message, in that workspace, with
 * the model, files, skills and web choice (web-tools.ts) made on the page. `from` is where the page's message box was
 * on screen (its left and bottom edges): the chat's box slides from there to its own place.
 */
export type FirstMessage = { text: string; files: File[]; skills: string[]; model: string; workspaceId: string; web: WebChoice; from?: { left: number; bottom: number } };

const waiting = new Map<string, FirstMessage>();

export function handOver(threadId: string, message: FirstMessage) {
	waiting.set(threadId, message);
}

/** The chat's first message, once: a chat that mounts again does not send it twice. */
export function takeFirstMessage(threadId: string) {
	const message = waiting.get(threadId);
	waiting.delete(threadId);
	return message;
}
