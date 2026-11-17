/**
 * A question asked on a workspace page (WorkspacePage.vue). The page starts a new chat, and
 * the chat (ChatView.vue) takes the question as its first message, in that workspace, with
 * the model, files and skills chosen on the page.
 */
export type FirstMessage = { text: string; files: File[]; skills: string[]; model: string; workspaceId: string };

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
