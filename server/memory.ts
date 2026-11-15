import type { UIMessage } from "ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type { SqlError } from "effect/sql/SqlError";
import * as PonderConfig from "./config.ts";
import { problem, recoverAll } from "./memory/errors.ts";
import { readExtractPrompt } from "./memory/extract.ts";
import { makeMemoryMiddleware, type MemoryContext } from "./memory/middleware.ts";
import * as MemoryStore from "./memory/postgres.ts";
import * as Tracing from "./tracing/Tracing.ts";

export type { MemoryContext } from "./memory/middleware.ts";

/**
 * Memory across chats: what the person told Ponder about themselves before. Ported from
 * the Seva platform, whose contract and middleware follow TanStack AI's (memory/types.ts,
 * memory/middleware.ts). Memories are in Postgres with a pgvector search index
 * (PONDER_MEMORY_INDEX=off leaves it out); memory/gate.json and memory/extract.md decide
 * what each turn adds. PONDER_MEMORY=off turns memory off. See docs/memory.md.
 */

/**
 * How memory works, for the model, on every run while memory is on. It must match what
 * gate.json and extract.md keep out, so the model never promises to remember what the
 * writer will refuse.
 */
const MEMORY_GUIDANCE = `You have a memory across conversations. It saves itself after each reply: you do not call a tool for it.
When the person asks you to remember or forget something, say you will. But memory never keeps passwords, keys or tokens, phone numbers, email addresses, home addresses, ID, bank or card numbers (theirs or anyone's), health details, or personal details about other people. If they ask you to remember one of those, say you cannot keep it in memory.`;

/** The Memory page: whether memory is on, the memories, the latest decisions, and the prompt that makes them. */
export type MemoryOverview = {
	enabled: boolean;
	adapter: string;
	memories: MemoryStore.StoredMemory[];
	saves: MemoryStore.MemorySave[];
	prompt: string;
};

export class Memory extends Context.Service<
	Memory,
	{
		/**
		 * What memory adds to a run, both empty when memory is off. The guidance never changes,
		 * so it goes in the instructions. What was recalled for the person's latest message
		 * changes each time, so it goes with that message (workflow/context.ts). Never fails:
		 * a recall that fails is logged, and the run goes on without it.
		 */
		readonly forRun: (ctx: MemoryContext, messages: UIMessage[]) => Effect.Effect<{ guidance: string; recalled: string }>;
		/** Saves the turn that ends the thread, in the background. Never fails, never waits. */
		readonly rememberTurn: (ctx: MemoryContext, messages: UIMessage[]) => Effect.Effect<void>;
		/**
		 * What one person can see and change in their memory: the Memory page, and the notes
		 * under each reply. Every call touches only `user`'s memories and decisions.
		 */
		readonly overview: (user: string) => Effect.Effect<MemoryOverview, SqlError>;
		/** False when the memory is not theirs. */
		readonly update: (user: string, id: string, text: string) => Effect.Effect<boolean, SqlError>;
		readonly forget: (user: string, id: string) => Effect.Effect<boolean, SqlError>;
		/** The operations it reversed; none when the save is not theirs or was undone already. */
		readonly undo: (user: string, saveId: number) => Effect.Effect<Option.Option<MemoryStore.AppliedOperation[]>, SqlError>;
		/** One chat's decisions. With `settle`, first waits for its save still running. */
		readonly threadSaves: (user: string, threadId: string, options?: { settle?: boolean }) => Effect.Effect<MemoryStore.MemorySave[], SqlError>;
		/** Creates the tables, and syncs the search index in the background. Startup runs it. */
		readonly setup: Effect.Effect<void, SqlError>;
	}
>()("ponder/memory/Memory") {}

/** The scope of a request: the signed-in person. Memory is not kept per chat. */
const memoryScope = ({ threadId, user }: MemoryContext) => ({ threadId, userId: user });

const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const store = yield* MemoryStore.MemoryStore;
	const middleware = yield* makeMemoryMiddleware({ adapter: store, scope: memoryScope });
	// The index sync runs in the layer's scope, so startup does not wait for it.
	const layerScope = yield* Effect.scope;
	const enabled = config.memoryEnabled;
	const scope = (user: string, threadId = "") => memoryScope({ threadId, user });
	const prompt = readExtractPrompt.pipe(Effect.provideService(PonderConfig.PonderConfig, config));

	// The span's name and attribute are the ones it had before Effect.
	const recall = Effect.fn("memory.recall")(function* (ctx: MemoryContext, messages: UIMessage[]) {
		const recalled = yield* middleware.recall(ctx, messages);
		// The count of memories recalled (postgres.ts numbers each one), never their text.
		yield* Tracing.annotate({ "ponder.recalled": recalled.match(/^\d+\. \[/gm)?.length ?? 0 });
		return { guidance: MEMORY_GUIDANCE, recalled };
	});

	const forRun = (ctx: MemoryContext, messages: UIMessage[]) => (enabled ? recall(ctx, messages) : Effect.succeed({ guidance: "", recalled: "" }));

	const rememberTurn = (ctx: MemoryContext, messages: UIMessage[]) => (enabled ? middleware.save(ctx, messages) : Effect.void);

	const overview = Effect.fn("Memory.overview")(function* (user: string) {
		const [memories, saves, text] = yield* Effect.all([store.list(scope(user)), store.saves(scope(user), { limit: 30 }), prompt], { concurrency: "unbounded" });
		return { enabled, adapter: store.name, memories, saves, prompt: text };
	});

	const threadSaves = Effect.fn("Memory.threadSaves")(function* (user: string, threadId: string, { settle = false }: { settle?: boolean } = {}) {
		if (settle) yield* middleware.settled(threadId);
		return yield* store.saves(scope(user, threadId), { threadId });
	});

	const setup = Effect.gen(function* () {
		yield* store.migrate;
		// The index is rebuilt from Postgres when it is missing or out of step; a failure leaves search to Postgres.
		yield* store.syncIndex.pipe(
			recoverAll((error) => Effect.logError("memory: could not sync the search index:", problem(error))),
			Effect.forkIn(layerScope),
		);
	});

	return Memory.of({
		forRun,
		rememberTurn,
		overview,
		update: (user, id, text) => store.update(scope(user), id, text),
		forget: (user, id) => store.forget(scope(user), id),
		undo: (user, saveId) => store.undo(scope(user), saveId),
		threadSaves,
		setup,
	});
});

export const layer = Layer.effect(Memory, make).pipe(Layer.provideMerge(MemoryStore.layer));
