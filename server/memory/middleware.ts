import type { UIMessage } from "ai";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { problem, recoverAll } from "./errors.ts";
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
 *
 * The saves run in the scope the middleware is made in (the Memory layer's, so the
 * runtime's): a request or a step that ends does not stop them.
 */
export type MemoryContext = { threadId: string; user: string };

/** How long a stop waits for the memory saves still running. */
const SAVE_GRACE = Duration.seconds(3);

// A constructor, run once by the Memory layer: no span.
export const makeMemoryMiddleware = Effect.fnUntraced(function* ({ adapter, scope }: { adapter: MemoryAdapter<unknown>; scope: (ctx: MemoryContext) => MemoryScope }) {
	const name = `memory:${adapter.id}`;
	// The saves run in a scope of their own, inside the layer's. Its finalizer, added after
	// it, runs first when the runtime is disposed (SIGTERM): it gives the saves still
	// running SAVE_GRACE to finish, as postgres.js's sql.end({ timeout: 3 }) gave their
	// queries, before the scope interrupts them and rolls back their transactions.
	const layerScope = yield* Effect.scope;
	const forks = yield* Scope.fork(layerScope);
	yield* Scope.addFinalizer(
		layerScope,
		Effect.suspend(() => Fiber.awaitAll([...pending.values()].flatMap((set) => [...set]))).pipe(Effect.interruptible, Effect.timeoutOption(SAVE_GRACE)),
	);
	// Saves still running, per thread, so the chat page can wait for one to show what was kept.
	const pending = new Map<string, Set<Fiber.Fiber<void>>>();
	// Replies being saved now: Stop and the run's last step can both save the same reply.
	const saving = new Set<string>();

	/** Text for the instructions: the recalled block. Empty when nothing is recalled. */
	const recall = Effect.fnUntraced(function* (ctx: MemoryContext, messages: UIMessage[]) {
		const query = userText(messages);
		if (!query) return "";
		return yield* adapter.recall(scope(ctx), query).pipe(
			Effect.map((result) => result.systemPrompt),
			recoverAll((error) => Effect.as(Effect.logError(`${name}: recall failed:`, problem(error)), "")),
		);
	});

	/** Saves the thread's last turn in the background. Never fails, never waits. */
	const save = Effect.fnUntraced(function* (ctx: MemoryContext, messages: UIMessage[]) {
		const turn = turnFrom(messages);
		if (!turn.user || !turn.assistant) return;
		const key = turn.messageId ?? `${ctx.threadId}:${messages.length}`;
		if (saving.has(key)) return;
		saving.add(key);
		// Forked from the caller, so the span is in the reply's trace (tracing.spec.ts looks for it).
		const fiber = yield* write(scope(ctx), turn).pipe(
			Effect.ensuring(Effect.sync(() => saving.delete(key))),
			Effect.forkIn(forks),
		);
		track(ctx.threadId, fiber);
	});

	// The span's name is the one it had before Effect: tracing.spec.ts looks for it.
	const write = Effect.fn("memory.save")(function* (resolved: MemoryScope, turn: MemoryTurn) {
		const receipts = yield* adapter.save(resolved, turn).pipe(recoverAll((error) => Effect.as(Effect.logError(`${name}: save failed:`, problem(error)), [])));
		for (const receipt of receipts) if (!receipt.ok) yield* Effect.logError(`${name}: save failed:`, receipt.error);
	});

	function track(threadId: string, fiber: Fiber.Fiber<void>) {
		const set = pending.get(threadId) ?? new Set();
		pending.set(threadId, set);
		set.add(fiber);
		fiber.addObserver(() => {
			set.delete(fiber);
			if (!set.size && pending.get(threadId) === set) pending.delete(threadId);
		});
	}

	/** Ends once the thread's saves have finished, or after `timeout`. */
	const settled = Effect.fnUntraced(function* (threadId: string, timeout: Duration.Input = "20 seconds") {
		const running = [...(pending.get(threadId) ?? [])];
		if (!running.length) return;
		yield* Fiber.awaitAll(running).pipe(Effect.timeoutOption(timeout));
	});

	return { name, recall, save, settled };
});

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
