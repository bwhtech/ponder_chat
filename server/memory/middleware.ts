import type { UIMessage } from "ai";
import type { MemoryAdapter, MemoryScope, MemoryTurn } from "./types.ts";

/**
 * TanStack AI's `memoryMiddleware` (`@tanstack/ai-memory` 1.0.0, src/middleware.ts), for a
 * workflow run. TanStack hooks into `chat()`; here the chat workflow calls the two hooks
 * from its steps:
 * - `recall` before the agent is built: recall with the person's latest words, and return
 *   the text to add to the instructions (TanStack's `onConfig`, phase init);
 * - `save` once the reply is saved: save the turn without waiting, so it never holds up
 *   the reply (TanStack's `onFinish` with `ctx.defer`).
 * Memory failures never stop the chat: the run goes on without memory.
 */
export type MemoryContext = { threadId: string; user: string };

export function memoryMiddleware({ adapter, scope }: { adapter: MemoryAdapter; scope: (ctx: MemoryContext) => MemoryScope }) {
	const name = `memory:${adapter.id}`;
	// Saves still running, per thread, so the chat page can wait for one to show what was kept.
	const pending = new Map<string, Set<Promise<void>>>();
	// Replies being saved now: Stop and the run's last step can both save the same reply.
	const saving = new Set<string>();

	/** Text for the instructions: the recalled block. Empty when nothing is recalled. */
	async function recall(ctx: MemoryContext, messages: UIMessage[]) {
		const query = userText(messages);
		if (!query) return "";
		try {
			return (await adapter.recall(scope(ctx), query)).systemPrompt;
		} catch (error) {
			console.error(`${name}: recall failed:`, errorMessage(error));
			return "";
		}
	}

	/** Saves the thread's last turn in the background. Never throws, never waits. */
	function save(ctx: MemoryContext, messages: UIMessage[]) {
		const turn = turnFrom(messages);
		if (!turn.user || !turn.assistant) return;
		const key = turn.messageId ?? `${ctx.threadId}:${messages.length}`;
		if (saving.has(key)) return;
		saving.add(key);
		track(ctx.threadId, write(scope(ctx), turn).finally(() => saving.delete(key)));
	}

	async function write(resolved: MemoryScope, turn: MemoryTurn) {
		try {
			const receipts = await adapter.save(resolved, turn);
			for (const receipt of receipts) if (!receipt.ok) console.error(`${name}: save failed:`, receipt.error);
		} catch (error) {
			console.error(`${name}: save failed:`, errorMessage(error));
		}
	}

	function track(threadId: string, promise: Promise<void>) {
		const set = pending.get(threadId) ?? new Set();
		pending.set(threadId, set);
		set.add(promise);
		void promise.finally(() => {
			set.delete(promise);
			if (!set.size) pending.delete(threadId);
		});
	}

	/** Resolves once the thread's saves have finished, or after `timeoutMs`. */
	async function settled(threadId: string, timeoutMs = 20_000) {
		const running = [...(pending.get(threadId) ?? [])];
		if (!running.length) return;
		await Promise.race([Promise.allSettled(running), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
	}

	return { name, recall, save, settled };
}

/**
 * The turn to save: what the person said last, and what the assistant wrote back. Tool
 * results and file contents stay out: memory comes from what the person says, not from
 * Python output or an attached file that could carry instructions.
 */
export function turnFrom(messages: UIMessage[]): MemoryTurn {
	const lastUser = messages.map((m) => m.role).lastIndexOf("user");
	const replies = messages.slice(lastUser + 1).filter((m) => m.role === "assistant");
	const assistant = replies
		.flatMap((m) => m.parts)
		.map((part) => (part.type === "text" ? part.text.trim() : ""))
		.filter(Boolean)
		.join("\n\n");
	return { user: userText(messages), assistant, messageId: replies.at(-1)?.id };
}

/** The text of the person's latest message. */
function userText(messages: UIMessage[]) {
	const last = [...messages].reverse().find((m) => m.role === "user");
	return (last?.parts ?? [])
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n")
		.trim();
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
